import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Employee } from "../../models.js";
import { workDate } from "../../security.js";
import { systemScope } from "../../shared/scope.js";
import { audit, fail, id, list } from "../../shared/workflow.js";
import { toPaise } from "./calculator.js";
import { BankAccount } from "./finance.js";
import { individualPayslipPDF } from "./individual-payslip-pdf.js";

const staffRoles = new Set([
  "Super Admin",
  "Admin",
  "HR Manager",
  "HR Executive",
  "Department Manager",
  "HR",
  "Manager",
]);
const managesPayslips = (user) => staffRoles.has(user.role?.name);
const schema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, required: true },
    month: { type: String, required: true },
    automatic: { type: Boolean, required: true },
    employeeSnapshot: mongoose.Schema.Types.Mixed,
    earnings: [mongoose.Schema.Types.Mixed],
    deductions: [mongoose.Schema.Types.Mixed],
    gross: Number,
    actual: Number,
    deductionsTotal: Number,
    net: Number,
  },
  { timestamps: true, strict: "throw" },
);
schema.index({ employee: 1, month: 1 }, { unique: true });
schema.index({ automatic: 1, employee: 1, month: 1 });

const IndividualPayslip = mongoose.model("IndividualPayslip", schema);
const month = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/);
const money = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/)
  .transform(toPaise);
const name = z.string().trim().min(1).max(80);
const input = z.object({
  employee: id,
  month,
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{5}\d{4}[A-Z]|)$/),
  earnings: z
    .array(z.object({ name, gross: money, actual: money }))
    .min(1)
    .max(40),
  deductions: z
    .array(
      z
        .object({
          name,
          mode: z.enum(["fixed", "percent"]),
          value: money,
        })
        .refine(
          (row) => row.mode !== "percent" || row.value <= 10000,
          "Percentage must be at most 100",
        ),
    )
    .max(40),
});
const active = { status: { $in: ["Active", "Probation"] } };

async function employeeDetails(employee) {
  const bank = await BankAccount.findOne({ employee: employee._id })
    .select("bankName maskedAccount")
    .lean();
  return {
    name: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
    code: employee.code,
    location: employee.branch,
    designation: employee.designation,
    joiningDate: employee.joiningDate
      ? employee.joiningDate.toISOString().slice(0, 10)
      : "",
    bankName: bank?.bankName,
    bankAccount: bank?.maskedAccount,
  };
}

export function individualAmounts(earnings, rules) {
  const gross = earnings.reduce((sum, row) => sum + row.gross, 0);
  const actual = earnings.reduce((sum, row) => sum + row.actual, 0);
  const deductions = rules.map(({ name, mode, value }) => ({
    name,
    mode,
    value,
    amount:
      mode === "percent"
        ? Number((BigInt(gross) * BigInt(value) + 5000n) / 10000n)
        : value,
  }));
  const deductionsTotal = deductions.reduce((sum, row) => sum + row.amount, 0);
  return {
    earnings,
    deductions,
    gross,
    actual,
    deductionsTotal,
    net: gross - deductionsTotal,
  };
}

function manage(req, _res, next) {
  if (!managesPayslips(req.user)) fail(403, "Payslip management access denied");
  next();
}

export function individualPayslipRoutes() {
  const router = Router();
  router.get("/individual-payslips/employees", manage, async (_req, res) => {
    const data = await systemScope(() =>
      Employee.find()
        .select("firstName lastName code")
        .sort({ firstName: 1, lastName: 1 })
        .lean(),
    );
    res.json({ data });
  });
  router.get("/individual-payslips/employees/:id", manage, async (req, res) => {
    const employeeId = id.parse(req.params.id);
    const data = await systemScope(async () => {
      const employee = await Employee.findById(employeeId).lean();
      if (!employee) fail(404, "Employee not found");
      const template = await IndividualPayslip.findOne({
        employee: employeeId,
        automatic: false,
      })
        .sort({ month: -1 })
        .lean();
      return { ...(await employeeDetails(employee)), template };
    });
    res.set("Cache-Control", "no-store").json({ data });
  });
  router.get("/individual-payslips", async (req, res) => {
    const employee = req.query.employee && id.parse(req.query.employee);
    const filter =
      managesPayslips(req.user) && employee
        ? { employee }
        : { employee: req.user.employee || null };
    res.set("Cache-Control", "no-store");
    res.json(
      await list(IndividualPayslip, filter, req, {
        select: "month gross actual deductionsTotal net automatic",
      }),
    );
  });
  router.post("/individual-payslips", manage, async (req, res) => {
    const data = input.parse(req.body);
    if (data.month > workDate().slice(0, 7))
      fail(422, "Select the current month or an earlier month");
    const employeeSnapshot = await systemScope(async () => {
      const employee = await Employee.findById(data.employee).lean();
      if (!employee) fail(404, "Employee not found");
      if (
        employee.lastWorkingDate &&
        data.month > employee.lastWorkingDate.slice(0, 7)
      )
        fail(
          422,
          "Select a month on or before the employee's last working date",
        );
      return { ...(await employeeDetails(employee)), pan: data.pan };
    });
    if (employeeSnapshot.joiningDate.slice(0, 7) > data.month)
      fail(422, "Select a month on or after the employee joined");
    const amounts = individualAmounts(data.earnings, data.deductions);
    if (amounts.net < 0)
      fail(422, "Deductions cannot exceed monthly gross pay");
    let record;
    try {
      await IndividualPayslip.init();
      record = await IndividualPayslip.create({
        employee: data.employee,
        month: data.month,
        employeeSnapshot,
        automatic: false,
        ...amounts,
      });
    } catch (error) {
      if (error.code === 11000)
        fail(409, "A payslip already exists for this employee and month");
      throw error;
    }
    await audit(req, "individual-payslip.generated", record.id);
    res.status(201).json({ data: { _id: record.id, month: record.month } });
  });
  router.get("/individual-payslips/:id/pdf", async (req, res) => {
    const filter = { _id: id.parse(req.params.id) };
    if (!managesPayslips(req.user)) filter.employee = req.user.employee || null;
    const record = await IndividualPayslip.findOne(filter).lean();
    if (!record) fail(404, "Payslip not found");
    const pdf = await individualPayslipPDF(record);
    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="ABCO-payslip-${record.month}.pdf"`,
        "Cache-Control": "no-store",
      })
      .send(pdf);
  });
  return router;
}

function nextMonth(month) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

export async function generateMonthlyPayslips(today = workDate()) {
  await IndividualPayslip.init();
  return systemScope(async () => {
    const currentMonth = today.slice(0, 7);
    const employees = IndividualPayslip.aggregate([
      { $match: { automatic: false, month: { $lt: currentMonth } } },
      { $group: { _id: "$employee", firstMonth: { $min: "$month" } } },
    ]).cursor();
    for await (const { _id, firstMonth } of employees) {
      const start = nextMonth(firstMonth);
      if (start >= currentMonth) continue;
      const employee = await Employee.findOne({ _id, ...active }).lean();
      if (!employee) continue;
      const slips = await IndividualPayslip.find({
        employee: _id,
        month: { $gte: firstMonth, $lt: currentMonth },
      })
        .select("month automatic")
        .lean();
      const byMonth = new Map(slips.map((slip) => [slip.month, slip]));
      let templateId = byMonth.get(firstMonth)._id;
      let template;
      let details;
      for (let month = start; month < currentMonth; month = nextMonth(month)) {
        if (
          employee.lastWorkingDate &&
          month > employee.lastWorkingDate.slice(0, 7)
        )
          break;
        const existing = byMonth.get(month);
        if (existing) {
          if (!existing.automatic) {
            templateId = existing._id;
            template = undefined;
          }
          continue;
        }
        template ??= await IndividualPayslip.findById(templateId).lean();
        details ??= await employeeDetails(employee);
        const employeeSnapshot = {
          ...details,
          pan: template.employeeSnapshot.pan,
        };
        const amounts = individualAmounts(
          template.earnings,
          template.deductions,
        );
        try {
          await IndividualPayslip.updateOne(
            { employee: _id, month },
            {
              $setOnInsert: {
                employeeSnapshot,
                automatic: true,
                ...amounts,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
            { upsert: true, timestamps: false, setDefaultsOnInsert: false },
          );
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
    }
  });
}

export function startMonthlyPayslipWorker() {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      await generateMonthlyPayslips();
    } catch (error) {
      console.error("Monthly payslip generation failed", error.message);
    } finally {
      running = false;
    }
  }
  void run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
