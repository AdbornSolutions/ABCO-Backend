import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import {
  audit,
  fail,
  id,
  list,
  permit,
  transaction,
} from "../../shared/workflow.js";
import { exportReport } from "../admin/exports.js";
import { PayrollEntry, PayrollPeriod } from "./models.js";

const fields = ["employeePF", "employerPF", "professionalTax", "tds"];
const reportName = "statutory-payroll";
const month = z
  .string()
  .regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, "Select a valid month");
const names = z.array(z.string().trim().min(1).max(100)).max(12);
const inputSchema = z.object({
  from: month,
  to: month,
  mappings: z.object(Object.fromEntries(fields.map((field) => [field, names]))),
});
const visibleStatuses = ["Finalized", "Paid", "Closed"];
const rowSchema = new mongoose.Schema(
  {
    month: String,
    employeeCode: String,
    employeeName: String,
    department: String,
    gross: Number,
    deductions: Number,
    employerContributions: Number,
    net: Number,
    ...Object.fromEntries(fields.map((field) => [field, Number])),
  },
  { _id: false },
);
const report = new mongoose.Schema(
  {
    from: String,
    to: String,
    mappings: Object.fromEntries(fields.map((field) => [field, [String]])),
    periods: [String],
    rows: [rowSchema],
    createdBy: mongoose.Schema.Types.ObjectId,
  },
  { timestamps: true, strict: "throw" },
);
export const StatutoryReport = mongoose.model("StatutoryReport", report);

function monthsInRange(from, to) {
  const ordinal = (value) =>
    Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
  const start = ordinal(from);
  const count = ordinal(to) - start + 1;
  if (count < 1 || count > 24) fail(422, "Choose a range of one to 24 months");
  return Array.from({ length: count }, (_, index) => {
    const value = start + index;
    return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;
  });
}
const normalize = (value) => value.trim().toLowerCase();
const sum = (parts) => parts.reduce((total, entry) => total + entry.amount, 0);

async function preview(input) {
  const months = monthsInRange(input.from, input.to);
  const mappings = Object.fromEntries(
    fields.map((field) => [
      field,
      [...new Set(input.mappings[field].map(normalize))],
    ]),
  );
  const deductionNames = [
    ...mappings.employeePF,
    ...mappings.professionalTax,
    ...mappings.tds,
  ];
  if (!deductionNames.length && !mappings.employerPF.length)
    fail(422, "Map at least one payroll component");
  if (new Set(deductionNames).size !== deductionNames.length)
    fail(422, "Assign each employee deduction to only one category");

  const periods = await PayrollPeriod.find({
    month: { $in: months },
    status: { $in: visibleStatuses },
  })
    .select("month version")
    .sort({ month: 1 })
    .lean();
  const byPeriod = new Map(
    periods.map((period) => [String(period._id), period]),
  );
  const missingMonths = months.filter(
    (value) => !periods.some((period) => period.month === value),
  );
  const entries = await PayrollEntry.find({
    period: { $in: periods.map((period) => period._id) },
  })
    .select(
      "period version employeeSnapshot gross deductionsTotal employerTotal net earnings deductions employerContributions",
    )
    .limit(3001)
    .lean();
  if (entries.length > 3000)
    fail(
      422,
      "Report exceeds 3,000 employee-month records. Shorten the range.",
    );
  const seen = Object.fromEntries(fields.map((field) => [field, new Set()]));
  const issues = [];
  for (const period of periods) {
    if (!entries.some((entry) => String(entry.period) === String(period._id)))
      issues.push(`No employee records found for ${period.month}`);
  }
  const rows = entries.map((entry) => {
    const period = byPeriod.get(String(entry.period));
    const employee = entry.employeeSnapshot || {};
    const employer = entry.employerContributions || [];
    if (
      !employee.code ||
      entry.version !== period.version ||
      sum(entry.earnings) !== entry.gross ||
      sum(entry.deductions) !== entry.deductionsTotal ||
      sum(employer) !== (entry.employerTotal || 0) ||
      entry.gross - entry.deductionsTotal !== entry.net
    ) {
      if (issues.length < 20)
        issues.push(
          `Payroll totals or snapshot do not reconcile for ${employee.code || "an employee"} in ${period.month}`,
        );
    }
    const values = Object.fromEntries(
      fields.map((field) => {
        const source = field === "employerPF" ? employer : entry.deductions;
        const matching = source.filter((component) => {
          const name = normalize(component.name);
          if (!mappings[field].includes(name)) return false;
          seen[field].add(name);
          return true;
        });
        return [field, sum(matching)];
      }),
    );
    return {
      month: period.month,
      employeeCode: employee.code,
      employeeName: employee.name,
      department: employee.department || "Unassigned",
      gross: entry.gross,
      deductions: entry.deductionsTotal,
      employerContributions: entry.employerTotal || 0,
      net: entry.net,
      ...values,
    };
  });
  const unmatched = fields.flatMap((field) =>
    mappings[field].filter((name) => !seen[field].has(name)),
  );
  rows.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      (a.employeeCode || "").localeCompare(b.employeeCode || ""),
  );
  return {
    from: input.from,
    to: input.to,
    mappings: input.mappings,
    periods: periods.map((period) => period.month),
    rows,
    missingMonths,
    unmatched,
    issues,
  };
}

export function statutoryReportRoutes() {
  const router = Router();
  router.use("/statutory-reports", permit("payroll.view"));
  router.get("/statutory-reports", async (req, res) => {
    res.json(
      await list(StatutoryReport, {}, req, {
        select: "from to periods createdAt",
      }),
    );
  });
  router.post("/statutory-reports/preview", async (req, res) => {
    res.json({ data: await preview(inputSchema.parse(req.body)) });
  });
  router.post(
    "/statutory-reports",
    permit("payroll.process"),
    async (req, res) => {
      const { missingMonths, unmatched, issues, ...snapshot } = await preview(
        inputSchema.parse(req.body),
      );
      if (
        !snapshot.rows.length ||
        missingMonths.length ||
        unmatched.length ||
        issues.length
      )
        fail(
          422,
          "Resolve missing payroll periods, component mappings, and reconciliation issues before saving",
        );
      const saved = await transaction(async (session) => {
        const [record] = await StatutoryReport.create(
          [{ ...snapshot, createdBy: req.user._id }],
          { session },
        );
        await audit(req, "statutory.report.saved", record.id, session);
        return record;
      });
      res.status(201).json({ data: saved });
    },
  );
  router.get("/statutory-reports/:id", async (req, res) => {
    const result = await StatutoryReport.findById(
      id.parse(req.params.id),
    ).lean();
    if (!result) fail(404, "Report not found");
    res.json({ data: result });
  });
  router.get("/statutory-reports/:id/export", async (req, res) => {
    const format = z.enum(["xlsx", "pdf"]).parse(req.query.format);
    const result = await StatutoryReport.findById(
      id.parse(req.params.id),
    ).lean();
    if (!result) fail(404, "Report not found");
    const currencyFields = [
      "gross",
      "deductions",
      "employerContributions",
      "net",
      ...fields,
    ];
    const records = result.rows.map((row) => ({
      Month: row.month,
      "Employee Code": row.employeeCode,
      Employee: row.employeeName,
      Department: row.department,
      ...Object.fromEntries(
        currencyFields.map((field) => [field + " (INR)", row[field] / 100]),
      ),
    }));
    await exportReport(req, res, reportName, records, format);
  });
  return router;
}
