import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import session from "express-session";
import argon2 from "argon2";
import request from "supertest";
import writeExcelFile from "write-excel-file/node";
import path from "node:path";
import { rm } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { Employee, Role, User } from "../src/models.js";
import { PayrollEntry, PayrollPeriod } from "../src/modules/payroll/models.js";
import { EmployeeCard } from "../src/modules/hr/id-cards.js";

async function cleanup(dbName, storage) {
  if (
    mongoose.connection.name !== dbName ||
    !/^abco_test_[a-f\d]{32}$/.test(dbName)
  )
    throw new Error("Unsafe test database cleanup refused");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (storage !== path.join(path.resolve("storage"), dbName))
    throw new Error("Unsafe test storage cleanup refused");
  await rm(storage, { recursive: true, force: true });
}

test("invoice, policy acknowledgement and statutory reporting workflows", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  const dbName = `abco_test_${randomUUID().replaceAll("-", "")}`;
  const storage = path.resolve("storage", dbName);
  process.env.DOCUMENT_KEY = randomBytes(32).toString("hex");
  process.env.DOCUMENT_STORAGE_PATH = storage;
  await mongoose.connect(
    `mongodb://127.0.0.1:${process.env.ABCO_TEST_MONGO_PORT || 27017}`,
    {
      dbName,
      serverSelectionTimeoutMS: 5000,
    },
  );
  try {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.init()),
    );
    const roles = await Role.create([
      {
        name: "HR",
        permissions: [
          "policies.manage",
          "documents.manage",
          "documents.issue",
          "onboarding.manage",
          "employee.records",
          "exit.manage",
          "exit.terminate",
        ],
      },
      {
        name: "Finance",
        permissions: [
          "invoices.manage",
          "payroll.view",
          "payroll.process",
          "exit.manage",
          "exit.terminate",
        ],
      },
      { name: "Employee", permissions: [], scope: "Own" },
    ]);
    const employee = await Employee.create({
      code: "EMP-1",
      firstName: "Sam",
      lastName: "Worker",
      email: "employee@example.test",
      department: "Operations",
      designation: "Engineer",
      joiningDate: new Date("2025-01-01"),
    });
    const password = randomBytes(16).toString("hex");
    const passwordHash = await argon2.hash(password);
    const emails = ["hr@example.test", "finance@example.test", employee.email];
    await User.create(
      emails.map((email, index) => ({
        email,
        name: roles[index].name,
        role: roles[index]._id,
        passwordHash,
        ...(index === 2 ? { employee: employee._id } : {}),
      })),
    );
    const app = createApp({
      sessionStore: new session.MemoryStore(),
      logLevel: "silent",
    });
    async function login(email) {
      const agent = request.agent(app);
      const csrf = await agent.get("/api/v1/auth/csrf").expect(200);
      const loggedIn = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrf.body.data.token)
        .send({ email, password })
        .expect(200);
      return {
        get: (path) => agent.get("/api/v1" + path),
        post: (path, body) =>
          agent
            .post("/api/v1" + path)
            .set("x-csrf-token", loggedIn.body.data.csrfToken)
            .send(body),
        patch: (path, body) =>
          agent
            .patch("/api/v1" + path)
            .set("x-csrf-token", loggedIn.body.data.csrfToken)
            .send(body),
        upload: (path, fields, buffer, filename) =>
          agent
            .post("/api/v1" + path)
            .set("x-csrf-token", loggedIn.body.data.csrfToken)
            .field(fields)
            .attach("file", buffer, filename),
      };
    }
    const [hr, finance, worker] = await Promise.all(emails.map(login));
    await t.test(
      "invoices reconcile exact amounts and record repeatable partial payments",
      async () => {
        await worker.get("/invoices").expect(403);
        const input = {
          invoiceDate: "2026-01-01",
          dueDate: "2026-01-20",
          companyGstin: "27AAPFU0939F1ZV",
          customer: { name: "Example + Co.", address: "1 Company Street" },
          items: [
            {
              description: "Consultancy",
              quantity: 3,
              unitPrice: "99.99",
              gstRate: 18,
            },
          ],
        };
        await finance
          .post("/invoices", { ...input, dueDate: "2025-12-31" })
          .expect(422);
        const created = await finance.post("/invoices", input).expect(201);
        const invoice = created.body.data;
        assert.equal(invoice.subtotal, 29997);
        assert.equal(invoice.tax, 5399);
        assert.equal(invoice.total, 35396);
        assert.match(invoice.number, /^INV-2026-\d{7}$/);
        const path = `/invoices/${invoice._id}`;
        const partial = {
          amount: "50.00",
          date: "2026-01-02",
          reference: "first-transfer",
        };
        assert.equal(
          (await finance.post(path + "/payments", partial).expect(200)).body
            .data.status,
          "Partially Paid",
        );
        assert.equal(
          (await finance.post(path + "/payments", partial).expect(200)).body
            .data.payments.length,
          1,
        );
        await finance
          .post(path + "/payments", {
            ...partial,
            reference: "too-high",
            amount: "304.00",
          })
          .expect(422);
        const paid = await finance
          .post(path + "/payments", {
            ...partial,
            reference: "final-transfer",
            amount: "303.96",
          })
          .expect(200);
        assert.equal(paid.body.data.status, "Paid");
        const matches = await finance
          .get("/invoices")
          .query({ search: "Example +", status: "Paid" })
          .expect(200);
        assert.equal(matches.body.meta.total, 1);
        await finance
          .get(path + "/pdf")
          .expect("content-type", /application\/pdf/)
          .expect(200);
      },
    );
    await t.test(
      "drafts stay private and acknowledgements remain bound to a published version",
      async () => {
        const draft = {
          title: "Attendance policy",
          category: "Attendance",
          body: "Use the attendance system daily.",
        };
        const created = await hr.post("/hr-policies", draft).expect(201);
        const path = `/hr-policies/${created.body.data._id}`;
        assert.equal(
          (await worker.get("/hr-policies").expect(200)).body.meta.total,
          0,
        );
        const listing = await hr.get("/hr-policies").expect(200);
        const first = await hr
          .post(path + "/publish", { revision: listing.body.data[0].__v })
          .expect(200);
        const revision = await hr
          .patch(path + "/draft", {
            ...draft,
            body: "Use the attendance system at shift start.",
            revision: first.body.data.__v,
          })
          .expect(200);
        const visible = (await worker.get("/hr-policies").expect(200)).body
          .data[0];
        assert.equal(visible.current.version, 1);
        assert.equal(visible.draft, undefined);
        await worker.post(path + "/acknowledge", { version: 1 }).expect(200);
        await worker.post(path + "/acknowledge", { version: 1 }).expect(200);
        await hr
          .post(path + "/publish", { revision: revision.body.data.__v })
          .expect(200);
        await worker.post(path + "/acknowledge", { version: 1 }).expect(409);
        assert.equal(
          (await worker.get("/hr-policies").expect(200)).body.data[0]
            .acknowledged,
          false,
        );
        const accepted = await hr
          .get(path + "/acknowledgements?version=1")
          .expect(200);
        assert.equal(accepted.body.meta.total, 1);
        assert.deepEqual(
          (await hr.get(path + "/versions").expect(200)).body.data.map(
            (item) => item.version,
          ),
          [2, 1],
        );
      },
    );
    await t.test(
      "statutory reports reconcile and persist only finalized payroll",
      async () => {
        const period = await PayrollPeriod.create({
          month: "2026-01",
          version: 1,
          status: "Finalized",
        });
        await PayrollEntry.create({
          period: period._id,
          employee: employee._id,
          version: 1,
          employeeSnapshot: {
            code: employee.code,
            name: "Sam Worker",
            department: employee.department,
          },
          gross: 5000000,
          deductionsTotal: 190000,
          employerTotal: 180000,
          net: 4810000,
          earnings: [{ name: "Basic", amount: 5000000 }],
          deductions: [
            { name: "Employee PF", amount: 180000 },
            { name: "PT", amount: 10000 },
          ],
          employerContributions: [{ name: "Employer PF", amount: 180000 }],
        });
        const payload = {
          from: "2026-01",
          to: "2026-01",
          mappings: {
            employeePF: ["Employee PF"],
            employerPF: ["Employer PF"],
            professionalTax: ["PT"],
            tds: [],
          },
        };
        await worker.post("/statutory-reports/preview", payload).expect(403);
        await finance
          .post("/statutory-reports", { ...payload, to: "2026-02" })
          .expect(422);
        const preview = await finance
          .post("/statutory-reports/preview", payload)
          .expect(200);
        assert.deepEqual(preview.body.data.issues, []);
        assert.equal(preview.body.data.rows[0].professionalTax, 10000);
        const created = await finance
          .post("/statutory-reports", payload)
          .expect(201);
        const path = `/statutory-reports/${created.body.data._id}`;
        assert.equal(
          (await finance.get(path).expect(200)).body.data.rows[0].employeePF,
          180000,
        );
        await finance.get(path + "/export?format=xlsx").expect(200);
        await finance.get(path + "/export?format=pdf").expect(200);
      },
    );
    await t.test(
      "payroll snapshots the selected PF ceiling and month-specific PT slab",
      async () => {
        const shared = {
          effectiveDate: "2025-02-01",
          jurisdiction: "Test jurisdiction",
          authorityReference: "Test rule set",
        };
        await worker.post("/statutory-rules", {}).expect(403);
        await finance
          .post("/statutory-rules", {
            ...shared,
            code: "PF-TEST",
            kind: "PF",
            wageComponents: ["Basic"],
            employeeRateBps: 12,
            employerRateBps: 10,
            wageCeiling: "15000",
            rounding: 100,
          })
          .expect(201);
        await finance
          .post("/statutory-rules", {
            ...shared,
            code: "PT-TEST",
            kind: "PT",
            wageComponents: [],
            slabs: [
              { minimumWage: "0", amount: "0" },
              {
                minimumWage: "25000.01",
                amount: "200",
                overrideMonth: 2,
                overrideAmount: "300",
              },
            ],
          })
          .expect(201);
        await finance
          .post("/salary-structures", {
            employee: employee._id,
            effectiveDate: "2025-02-01",
            pfRule: "pf-test",
            ptRule: "PT-TEST",
            earnings: [
              { name: "Basic", amount: "30000" },
              { name: "Allowance", amount: "10000" },
            ],
          })
          .expect(201);
        const period = await finance
          .post("/payroll/periods", {
            month: "2025-02",
            payBasis: "Calendar days",
          })
          .expect(201);
        const periodPath = `/payroll/periods/${period.body.data._id}`;
        await finance.post(periodPath + "/calculate", {}).expect(200);
        const [entry] = (await finance.get(periodPath + "/entries").expect(200))
          .body.data;
        assert.equal(entry.gross, 4000000);
        assert.equal(entry.deductionsTotal, 210000);
        assert.equal(entry.employerTotal, 150000);
        assert.equal(entry.net, 3790000);
        assert.deepEqual(
          entry.statutorySnapshot.map(({ code, wage, deduction }) => [
            code,
            wage,
            deduction,
          ]),
          [
            ["PF-TEST", 1500000, 180000],
            ["PT-TEST", 4000000, 30000],
          ],
        );
      },
    );
    await t.test(
      "the document inventory accepts real XLSX files and filters without bypassing access",
      async () => {
        const xlsx = await writeExcelFile([
          [{ type: String, value: "Employee record" }],
        ]).toBuffer();
        const data = {
          employee: String(employee._id),
          name: "Joining workbook",
          category: "Other Records",
          visibility: "HR Only",
          expiresAt: "2025-01-01",
        };
        await hr
          .upload("/documents", data, Buffer.from("PK invalid"), "bad.xlsx")
          .expect(422);
        const uploaded = await hr
          .upload("/documents", data, xlsx, "joining.xlsx")
          .expect(201);
        const documentPath = `/documents/${uploaded.body.data._id}`;
        const filtered = await hr
          .get("/documents")
          .query({ search: "workbook", expiry: "Expired", status: "Pending" })
          .expect(200);
        assert.equal(filtered.body.meta.total, 1);
        const link = await hr.post(documentPath + "/access", {}).expect(200);
        await hr
          .get(link.body.data.url.replace("/api/v1", ""))
          .expect("content-type", /spreadsheetml/)
          .expect("content-disposition", /\.xlsx/)
          .expect(200);
        assert.equal(
          (await worker.get("/documents").expect(200)).body.meta.total,
          0,
        );
        await worker.post(documentPath + "/access", {}).expect(403);
      },
    );
    await t.test(
      "onboarding issues a private ID card and reissue revokes the old QR",
      async () => {
        const record = await hr
          .post("/onboarding", {
            employee: employee._id,
            checklist: [
              {
                owner: employee._id,
                title: "Complete orientation",
                deadline: "2026-02-01",
              },
            ],
          })
          .expect(201);
        const onboardingPath = `/onboarding/${record.body.data._id}`;
        await hr.post(onboardingPath + "/approve", {}).expect(409);
        await worker
          .post(
            onboardingPath +
              `/items/${record.body.data.checklist[0]._id}/complete`,
            {},
          )
          .expect(200);
        await hr.post(onboardingPath + "/approve", {}).expect(200);
        await hr.post(onboardingPath + "/approve", {}).expect(200);
        const listing = await worker.get("/employee-id-cards").expect(200);
        const [card] = listing.body.data;
        assert.equal(card.version, 1);
        assert.equal(card.token, undefined);
        await worker
          .get(`/employee-id-cards/${card._id}/pdf`)
          .expect("content-type", /application\/pdf/)
          .expect(200);
        await finance.get(`/employee-id-cards/${card._id}/pdf`).expect(404);
        const old = await EmployeeCard.findById(card._id).select("+token");
        await hr
          .get("/employee-id-cards/verify")
          .query({ token: old.token })
          .expect(200);
        await hr
          .post("/employee-id-cards/regenerate", { employee: employee._id })
          .expect(200);
        await hr
          .get("/employee-id-cards/verify")
          .query({ token: old.token })
          .expect(404);
        assert.equal(
          (await worker.get("/employee-id-cards").expect(200)).body.data[0]
            .version,
          2,
        );
      },
    );
    await t.test(
      "employee history is private and stale revisions fail",
      async () => {
        const background = {
          revision: 0,
          education: [
            {
              institution: "Example University",
              qualification: "Degree",
              completedYear: 2020,
            },
          ],
          employment: [
            {
              employer: "Prior Company",
              title: "Engineer",
              from: "2020-05-01",
              to: "2024-12-31",
            },
          ],
        };
        const endpoint = `/employees/${employee._id}/background`;
        await finance.get(endpoint).expect(403);
        await worker.patch(endpoint, background).expect(403);
        await hr.patch(endpoint, background).expect(200);
        await hr.patch(endpoint, background).expect(409);
        assert.equal(
          (await worker.get("/employees/me/background").expect(200)).body.data
            .employment[0].employer,
          "Prior Company",
        );
      },
    );
    await t.test(
      "termination requires independent approval before issuing a versioned letter",
      async () => {
        const termination = {
          employee: employee._id,
          noticeDate: "2026-03-01",
          lastWorkingDate: "2026-03-31",
          reason: "Company initiated exit",
          handover: "Return assigned assets",
        };
        await worker.post("/terminations", termination).expect(403);
        const opened = await hr.post("/terminations", termination).expect(201);
        const transition = `/exits/${opened.body.data._id}/transition`;
        assert.equal(
          (await worker.get("/exits").expect(200)).body.meta.total,
          0,
        );
        await hr
          .post(transition, {
            status: "Under Review",
            note: "Submitting for independent review",
          })
          .expect(200);
        await hr
          .post(transition, {
            status: "Approved",
            note: "Self approval is denied",
          })
          .expect(403);
        const template = {
          name: "Termination notice",
          kind: "Termination",
          body: "{{employeeName}}, this is the official separation notice.",
        };
        const initial = await hr
          .post("/document-templates", template)
          .expect(201);
        const revised = await hr
          .patch(`/document-templates/${initial.body.data._id}`, template)
          .expect(201);
        assert.equal(revised.body.data.version, 2);
        const issue = {
          template: revised.body.data._id,
          employee: employee._id,
        };
        await hr.post("/generated-letters", issue).expect(409);
        await finance
          .post(transition, {
            status: "Approved",
            note: "Independent review completed",
          })
          .expect(200);
        await hr
          .post("/generated-letters", { ...issue, preview: true })
          .expect("content-type", /application\/pdf/)
          .expect(200);
        assert.equal(
          (await hr.get("/generated-letters").expect(200)).body.meta.total,
          0,
        );
        const issued = await hr.post("/generated-letters", issue).expect(201);
        assert.match(issued.body.data.reference, /^HR-[A-F0-9]{24}$/);
        assert.equal(
          (await worker.get("/exits").expect(200)).body.meta.total,
          1,
        );
      },
    );
  } finally {
    await cleanup(dbName, storage);
  }
});
