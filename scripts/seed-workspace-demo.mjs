import argon2 from "argon2";
import mongoose from "mongoose";
import { seedDemo } from "./seed-demo.mjs";
import { createInitialAdmin } from "../src/setup.js";
import { workDate } from "../src/security.js";
import { addDays } from "../src/modules/attendance/engine.js";
import { calculateSalary } from "../src/modules/payroll/calculator.js";
import { applyStatutoryRules } from "../src/modules/payroll/statutory-rules.js";
import { issueEmployeeCard } from "../src/modules/hr/id-cards.js";

const size = 24;
const ownerEmail = "owner@demo.example.test";
const accounts = [
  ["Department Manager", "department.manager", 0],
  ["Team Leader", "team.leader", 1],
  ["Admin", "admin", 2],
  ["HR Manager", "hr.manager", 3],
  ["HR Executive", "hr.executive", 4],
  ["Payroll / Finance", "finance", 5],
  ["Payroll Approver", "payroll.approver", 6],
  ["Employee", "employee", 8],
];
const models = mongoose.models;
const password = process.env.DEMO_PASSWORD;
const dateAt = (date, time) => new Date(`${date}T${time}:00+05:30`);
const emailFor = (name) => `${name}@demo.example.test`;
const employeeName = (employee) => `${employee.firstName} ${employee.lastName}`;
const insert = (name, filter, values) =>
  models[name].findOneAndUpdate(
    filter,
    { $setOnInsert: values },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

function demoUri() {
  const uri = new URL(process.env.MONGODB_URI || "mongodb://invalid");
  if (
    process.env.NODE_ENV !== "development" ||
    uri.protocol !== "mongodb:" ||
    uri.hostname !== "127.0.0.1" ||
    uri.pathname !== "/abco_demo" ||
    uri.username ||
    uri.password ||
    process.env.DOCUMENT_STORAGE_PATH !== "storage/demo-documents" ||
    !password ||
    password.length < 12
  ) {
    throw new Error(
      "Use the isolated loopback abco_demo database and local demo document storage.",
    );
  }
  return uri.href;
}

async function setupAccounts(employees, owner) {
  const hash = await argon2.hash(password);
  const users = [owner];
  for (const [roleName, alias, index] of accounts) {
    const employee = employees[index];
    const role = await models.Role.findOne({ name: roleName }).orFail();
    const email = emailFor(alias);
    let user = await models.User.findOne({ email, employee: employee._id });
    if (!user) {
      user = await models.User.findOneAndUpdate(
        {
          employee: employee._id,
          email: `demo.employee${index + 1}@example.test`,
          active: false,
        },
        { $set: { email, role: role._id, active: true, passwordHash: hash } },
        { new: true },
      ).orFail();
    }
    await models.Employee.updateOne(
      { _id: employee._id, email: { $ne: email } },
      { $set: { email } },
    );
    users.push(user);
    await insert(
      "Notification",
      { user: user._id, title: "DEMO: your workspace is ready" },
      {
        user: user._id,
        title: "DEMO: your workspace is ready",
        body: `Open Overview for your ${roleName} dashboard and navigate to the sample records from there.`,
        path: "/",
      },
    );
  }
  return users;
}

async function seedPeople(employees, owner, today) {
  const holidayDate = `${today.slice(0, 7)}-15`;
  for (const [name, date, optional] of [
    ["DEMO Foundation Day", holidayDate, false],
    ["DEMO Community Day", `${today.slice(0, 7)}-22`, true],
    ["DEMO Company Holiday", addDays(today, 8), false],
  ]) {
    await insert(
      "Holiday",
      { name, date },
      {
        name,
        date,
        branch: "",
        optional,
        active: true,
        category: optional ? "Optional" : "Company",
      },
    );
  }
  const shifts = await models.ShiftAssignment.find({
    employee: { $in: employees.map((employee) => employee._id) },
  }).lean();
  const byEmployee = new Map(
    shifts.map((shift) => [String(shift.employee), shift]),
  );
  const attendance = [];
  for (const [index, employee] of employees.entries()) {
    const shift = byEmployee.get(String(employee._id));
    for (let offset = 0; offset <= 20; offset++) {
      const date = addDays(today, -offset);
      const weekday = new Date(date + "T12:00:00Z").getUTCDay();
      if (shift.weeklyOffDays.includes(weekday) || date === holidayDate)
        continue;
      if (offset === 0 && index % 4 === 0) continue;
      if (date < employee.joiningDate.toISOString().slice(0, 10)) continue;
      const start = dateAt(date, shift.startTime);
      const end = dateAt(date, shift.endTime);
      const scenario = (index + offset) % 11;
      const lateMinutes = scenario === 4 ? 18 : 0;
      const halfDay = scenario === 8;
      const absent = scenario === 10;
      const open = offset === 0;
      const status = absent ? "Absent" : "Present";
      const punchIn = absent
        ? undefined
        : new Date(start.getTime() + lateMinutes * 60000);
      const punchOut =
        absent || open
          ? undefined
          : halfDay
            ? new Date(start.getTime() + 270 * 60000)
            : end;
      attendance.push({
        updateOne: {
          filter: { employee: employee._id, date },
          update: {
            $setOnInsert: {
              employee: employee._id,
              date,
              status,
              punchIn,
              punchOut,
              lateMinutes,
              scheduledStart: start,
              scheduledEnd: end,
              shiftSnapshot: {
                name: shift.shift,
                startTime: shift.startTime,
                endTime: shift.endTime,
                timezone: shift.timezone,
                fullDayMinutes: shift.fullDayMinutes,
                halfDayMinutes: shift.halfDayMinutes,
                graceMinutes: shift.graceMinutes,
              },
              workingMinutes: punchOut ? (punchOut - punchIn) / 60000 : 0,
              attendanceClass: absent
                ? "Absent"
                : halfDay
                  ? "Half Day"
                  : "Present",
            },
          },
          upsert: true,
        },
      });
    }
    const from = addDays(employee.joiningDate.toISOString().slice(0, 10), -365);
    const to = addDays(employee.joiningDate.toISOString().slice(0, 10), -1);
    await insert(
      "EmployeeBackground",
      { employee: employee._id },
      {
        employee: employee._id,
        education: [
          {
            institution: "DEMO School of Business and Technology",
            qualification: ["B.Tech", "MBA", "B.Com"][index % 3],
            completedYear: 2016 + (index % 8),
          },
        ],
        employment: [
          { employer: "DEMO Meridian Services", title: "Associate", from, to },
        ],
      },
    );
    if (index % 4 === 0) {
      const onboarding = await models.Onboarding.findOne({
        employee: employee._id,
      }).orFail();
      if (
        onboarding.status === "In Progress" &&
        !(await models.EmployeeCard.exists({ employee: employee._id }))
      ) {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const current = await models.Onboarding.findById(
              onboarding._id,
            ).session(session);
            for (const item of current.checklist) {
              item.done = true;
              item.completedAt = dateAt(today, "09:00");
            }
            current.status = "Completed";
            current.completedAt = dateAt(today, "09:00");
            current.approvedBy = owner._id;
            await current.save({ session });
            await issueEmployeeCard(
              { user: owner, id: "abco-demo" },
              employee._id,
              session,
            );
          });
        } finally {
          await session.endSession();
        }
      }
    }
  }
  await models.Attendance.bulkWrite(attendance);
}

async function seedPolicies(employees, owner, today) {
  for (const [index, [category, instruction]] of [
    [
      "Attendance",
      "Record check-in and check-out on working days. Submit corrections for missed punches.",
    ],
    [
      "Leave",
      "Submit time-off requests in advance and review your balance before applying.",
    ],
    [
      "Work from home",
      "Agree on remote days with your reporting manager and record attendance as usual.",
    ],
    [
      "Code of conduct",
      "Treat colleagues with respect and report workplace concerns to HR.",
    ],
    [
      "Payroll",
      "Review payslips after release and contact Finance about discrepancies.",
    ],
    [
      "Handbook",
      "Use the directory, helpdesk and calendar to find people and workplace information.",
    ],
  ].entries()) {
    const title = `DEMO ${category} policy`;
    const policy = await insert(
      "HrPolicy",
      { "current.title": title },
      {
        current: {
          title,
          category,
          body: `Fictional sample policy for the demo. ${instruction}`,
          version: 1,
          publishedAt: dateAt(addDays(today, -7), "09:00"),
          publishedBy: owner._id,
        },
      },
    );
    for (const employee of employees.slice(0, 6 + index)) {
      const acknowledgement = {
        policy: policy._id,
        employee: employee._id,
        version: 1,
      };
      await insert("PolicyAcknowledgement", acknowledgement, acknowledgement);
    }
  }
}

async function seedFinance(employees, users, today) {
  const finance = users.find((user) => user.email === emailFor("finance"));
  const approver = users.find(
    (user) => user.email === emailFor("payroll.approver"),
  );
  const company = {
    name: "ABCO Demo Workspace",
    address: "Fictional Mumbai office",
  };
  const [year, month] = today.split("-").map(Number);
  const monthAt = (offset) =>
    new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
  const effectiveDate = monthAt(-3) + "-01";
  const pf = await insert(
    "StatutoryRule",
    { code: "DEMO-PF", kind: "PF", effectiveDate },
    {
      code: "DEMO-PF",
      kind: "PF",
      effectiveDate,
      jurisdiction: "Fictional example",
      authorityReference: "Sample figures for demo calculations",
      wageComponents: ["Basic salary"],
      employeeRateBps: 1000,
      employerRateBps: 1000,
      wageCeiling: 1500000,
      rounding: 100,
    },
  );
  const pt = await insert(
    "StatutoryRule",
    { code: "DEMO-PT", kind: "PT", effectiveDate },
    {
      code: "DEMO-PT",
      kind: "PT",
      effectiveDate,
      jurisdiction: "Fictional example",
      authorityReference: "Sample figures for demo calculations",
      wageComponents: [],
      slabs: [
        { minimumWage: 0, amount: 0 },
        { minimumWage: 2500001, amount: 20000 },
      ],
    },
  );
  const reportRows = [];
  for (const [offset, status] of [
    [-3, "Paid"],
    [-2, "Finalized"],
    [-1, "Under Review"],
  ]) {
    const periodMonth = monthAt(offset);
    const startDate = periodMonth + "-01";
    const endDate = addDays(monthAt(offset + 1) + "-01", -1);
    const periodDays = Number(endDate.slice(-2));
    const period = await insert(
      "PayrollPeriod",
      { month: periodMonth },
      {
        month: periodMonth,
        startDate,
        endDate,
        companySnapshot: company,
        payBasis: "Calendar days",
        status,
        version: 1,
        processor: finance._id,
        ...(status !== "Under Review" && { approver: approver._id }),
        ...(status === "Paid" && {
          paymentReference: "DEMO-SALARY-" + periodMonth,
          paidAt: dateAt(endDate, "17:00"),
        }),
        history: [
          {
            status: "Calculated",
            actor: finance._id,
            at: dateAt(endDate, "09:00"),
          },
          {
            status,
            actor: status === "Under Review" ? finance._id : approver._id,
            at: dateAt(endDate, "17:00"),
          },
        ],
      },
    );
    for (const [index, employee] of employees.entries()) {
      const joined = employee.joiningDate.toISOString().slice(0, 10);
      if (joined > endDate) continue;
      const salary = await insert(
        "SalaryStructure",
        { employee: employee._id, effectiveDate },
        {
          employee: employee._id,
          effectiveDate,
          currency: "INR",
          overtimeRate: 0,
          pfRule: pf.code,
          ptRule: pt.code,
          earnings: [
            {
              name: "Basic salary",
              amount: 2400000 + index * 118000,
              prorate: true,
            },
            {
              name: "Housing allowance",
              amount: 900000 + index * 21000,
              prorate: true,
            },
            { name: "Transport allowance", amount: 160000, prorate: true },
          ],
          deductions: [],
          employerContributions: [],
          createdBy: finance._id,
        },
      );
      const payableDays =
        joined > startDate
          ? periodDays - Number(joined.slice(-2)) + 1
          : periodDays;
      const calculation = calculateSalary(
        salary.toObject(),
        payableDays,
        periodDays,
      );
      const statutorySnapshot = applyStatutoryRules(
        calculation,
        [pf, pt],
        Number(periodMonth.slice(-2)),
        employee.code,
      );
      const snapshot = {
        name: employeeName(employee),
        code: employee.code,
        department: employee.department,
        designation: employee.designation,
      };
      const row = await insert(
        "PayrollEntry",
        { period: period._id, employee: employee._id },
        {
          period: period._id,
          employee: employee._id,
          version: period.version,
          employeeSnapshot: snapshot,
          salarySnapshot: {
            effectiveDate,
            currency: "INR",
            pfRule: pf.code,
            ptRule: pt.code,
            earnings: salary.earnings,
            deductions: salary.deductions,
            employerContributions: salary.employerContributions,
          },
          periodDays,
          payableDays,
          unpaidDays: periodDays - payableDays,
          ...calculation,
          statutorySnapshot,
        },
      );
      if (status !== "Under Review") {
        reportRows.push({
          month: periodMonth,
          employeeCode: snapshot.code,
          employeeName: snapshot.name,
          department: snapshot.department,
          gross: row.gross,
          deductions: row.deductionsTotal,
          employerContributions: row.employerTotal,
          net: row.net,
          employeePF:
            row.deductions.find((entry) => entry.name === "Employee PF")
              ?.amount || 0,
          employerPF:
            row.employerContributions.find(
              (entry) => entry.name === "Employer PF",
            )?.amount || 0,
          professionalTax:
            row.deductions.find((entry) => entry.name === "Professional Tax")
              ?.amount || 0,
          tds: 0,
        });
      }
    }
  }
  const from = monthAt(-3),
    to = monthAt(-2);
  await insert(
    "StatutoryReport",
    { from, to, createdBy: finance._id },
    {
      from,
      to,
      createdBy: finance._id,
      periods: [from, to],
      rows: reportRows,
      mappings: {
        employeePF: ["Employee PF"],
        employerPF: ["Employer PF"],
        professionalTax: ["Professional Tax"],
        tds: [],
      },
    },
  );
  for (let index = 0; index < 12; index++) {
    const number = `DEMO-INV-${String(index + 1).padStart(4, "0")}`;
    const invoiceDate = addDays(today, -(15 + index));
    const subtotal = 1200000 + index * 125000;
    const tax = (subtotal * 18) / 100;
    const total = subtotal + tax;
    const paid = [0, total / 2, total][index % 3];
    await insert(
      "Invoice",
      { number },
      {
        number,
        company,
        customer: {
          name: `DEMO ${["Meridian", "Bluebird", "Summit", "Harbor"][index % 4]} Client ${index + 1}`,
          address: "Fictional billing address",
        },
        invoiceDate,
        dueDate: addDays(invoiceDate, 30),
        items: [
          {
            description: "DEMO monthly support services",
            quantity: 1,
            unitPrice: subtotal,
            gstRate: 18,
            subtotal,
            tax,
          },
        ],
        subtotal,
        tax,
        total,
        paid,
        status: ["Unpaid", "Partially Paid", "Paid"][index % 3],
        payments: paid
          ? [
              {
                reference: "DEMO-TRANSFER-" + number,
                date: addDays(invoiceDate, 3),
                amount: paid,
                actor: finance._id,
              },
            ]
          : [],
        createdBy: finance._id,
      },
    );
  }
}

try {
  await mongoose.connect(demoUri(), { serverSelectionTimeoutMS: 5000 });
  const topology = await mongoose.connection.db.admin().command({ hello: 1 });
  if (topology.setName !== "abcoDemo")
    throw new Error("The isolated abcoDemo replica set is required.");
  await Promise.all(Object.values(models).map((model) => model.init()));
  if (!(await models.User.exists({ email: ownerEmail }))) {
    await createInitialAdmin({
      name: "Demo Workspace Owner",
      email: ownerEmail,
      password,
    });
  }
  const owner = await models.User.findOne({ email: ownerEmail })
    .populate("role")
    .orFail();
  const report = await seedDemo({ size });
  const today = report.anchorDate || workDate();
  const employees = await Promise.all(
    Array.from({ length: size }, (_, index) =>
      models.Employee.findOne({ code: `DEMO-EMP-00${index + 1}` }).orFail(),
    ),
  );
  const users = await setupAccounts(employees, owner);
  await insert(
    "CompanySettings",
    { _id: "company" },
    {
      name: "ABCO Demo Workspace",
      address: "Fictional Mumbai office",
      timezone: "Asia/Kolkata",
      financialYearStartMonth: 4,
      allowShiftSwaps: true,
      allowWorkFromHome: true,
    },
  );
  await seedPeople(employees, owner, today);
  await seedPolicies(employees, owner, today);
  await seedFinance(employees, users, today);
  const collections = await mongoose.connection.db
    .listCollections({}, { nameOnly: true })
    .toArray();
  const counts = (
    await Promise.all(
      collections.map(async ({ name }) => [
        name,
        await mongoose.connection.db.collection(name).countDocuments(),
      ]),
    )
  ).filter(([, count]) => count);
  const summary = {
    employees: employees.length,
    demoLogins: users.length,
    populatedCollections: counts.length,
    totalRecords: counts.reduce((sum, [, count]) => sum + count, 0),
    attendance: await models.Attendance.countDocuments(),
    invoices: await models.Invoice.countDocuments(),
    payrollEntries: await models.PayrollEntry.countDocuments(),
  };
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
