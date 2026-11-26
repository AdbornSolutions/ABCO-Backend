import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import {
  audit,
  date,
  fail,
  list,
  permit,
  transaction,
} from "../../shared/workflow.js";
import { PayrollPeriod } from "./models.js";
import { toPaise } from "./calculator.js";

const { Schema } = mongoose;
const slabs = new Schema(
  {
    minimumWage: Number,
    amount: Number,
    overrideMonth: Number,
    overrideAmount: Number,
  },
  { _id: false },
);
const policy = new Schema(
  {
    code: String,
    kind: { type: String, enum: ["PF", "PT"] },
    effectiveDate: String,
    jurisdiction: String,
    authorityReference: String,
    wageComponents: [String],
    employeeRateBps: Number,
    employerRateBps: Number,
    wageCeiling: Number,
    rounding: Number,
    slabs: [slabs],
  },
  { timestamps: true, strict: "throw" },
);
policy.index({ kind: 1, code: 1, effectiveDate: -1 }, { unique: true });
export const StatutoryRule = mongoose.model("StatutoryRule", policy);

export const ruleCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9][A-Z0-9-]{0,39}$/,
    "Use a policy code of 1 to 40 letters, numbers or hyphens",
  );
const money = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an INR amount with up to two decimals")
  .transform(toPaise);
const rate = z
  .number()
  .min(0)
  .max(100)
  .multipleOf(0.01)
  .transform((value) => Math.round(value * 100));
const optionalMoney = z.preprocess(
  (value) => (value === "" ? undefined : value),
  money.optional(),
);
const common = {
  code: ruleCode,
  effectiveDate: date.refine(
    (value) => value.endsWith("-01"),
    "Use the first day of a payroll month",
  ),
  jurisdiction: z.string().trim().min(1).max(120),
  authorityReference: z.string().trim().min(3).max(500),
  wageComponents: z.array(z.string().trim().min(1).max(100)).max(30),
};
const input = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("PF"),
    employeeRateBps: rate,
    employerRateBps: rate,
    wageCeiling: optionalMoney,
    rounding: z.union([z.literal(1), z.literal(100)]),
  }),
  z.object({
    ...common,
    kind: z.literal("PT"),
    slabs: z
      .array(
        z
          .object({
            minimumWage: money,
            amount: money,
            overrideMonth: z.number().int().min(1).max(12).optional(),
            overrideAmount: optionalMoney,
          })
          .refine(
            (value) =>
              (value.overrideMonth == null) === (value.overrideAmount == null),
            "An override month and amount must be entered together",
          ),
      )
      .min(1)
      .max(30),
  }),
]);
const normalize = (name) => name.trim().toLowerCase();

export async function resolveStatutoryRules(codes, startDate, session) {
  const result = [];
  for (const [kind, code] of [
    ["PF", codes.pfRule],
    ["PT", codes.ptRule],
  ]) {
    if (!code) continue;
    const rule = await StatutoryRule.findOne({
      kind,
      code,
      effectiveDate: { $lte: startDate },
    })
      .sort({ effectiveDate: -1 })
      .session(session)
      .lean();
    if (!rule) fail(422, `No effective ${kind} rule for policy ${code}`);
    result.push(rule);
  }
  return result;
}

function roundedContribution(wage, rate, unit) {
  const denominator = 10000n * BigInt(unit);
  return (
    Number((BigInt(wage) * BigInt(rate) + denominator / 2n) / denominator) *
    unit
  );
}
export function applyStatutoryRules(calculation, rules, month, employeeCode) {
  const snapshots = [];
  for (const rule of rules) {
    const components = rule.wageComponents.map(normalize);
    if (
      components.some(
        (name) =>
          !calculation.earnings.some((entry) => normalize(entry.name) === name),
      )
    )
      fail(
        422,
        `${employeeCode}: earning components for ${rule.code} are missing`,
      );
    let wage = components.length
      ? calculation.earnings
          .filter((entry) => components.includes(normalize(entry.name)))
          .reduce((total, entry) => total + entry.amount, 0)
      : calculation.gross;
    const employeeName =
      rule.kind === "PF" ? "Employee PF" : "Professional Tax";
    const employerName = "Employer PF";
    if (
      calculation.deductions.some(
        (item) => normalize(item.name) === normalize(employeeName),
      ) ||
      (rule.kind === "PF" &&
        calculation.employerContributions.some(
          (item) => normalize(item.name) === normalize(employerName),
        ))
    ) {
      fail(
        422,
        `${employeeCode}: remove the manual ${rule.kind} component before applying ${rule.code}`,
      );
    }
    let deduction = 0;
    let employer = 0;
    if (rule.kind === "PF") {
      if (rule.wageCeiling != null) wage = Math.min(wage, rule.wageCeiling);
      deduction = roundedContribution(
        wage,
        rule.employeeRateBps,
        rule.rounding,
      );
      employer = roundedContribution(wage, rule.employerRateBps, rule.rounding);
      calculation.employerContributions.push({
        name: employerName,
        amount: employer,
        prorate: false,
      });
      calculation.employerTotal += employer;
    } else if (wage) {
      const band = rule.slabs.findLast((slab) => wage >= slab.minimumWage);
      deduction =
        band?.overrideMonth === month ? band.overrideAmount : band?.amount || 0;
    }
    calculation.deductions.push({
      name: employeeName,
      amount: deduction,
      prorate: false,
    });
    calculation.deductionsTotal += deduction;
    calculation.net -= deduction;
    snapshots.push({
      rule: rule._id,
      kind: rule.kind,
      code: rule.code,
      effectiveDate: rule.effectiveDate,
      wage,
      deduction,
      employer,
    });
  }
  return snapshots;
}

export function statutoryRuleRoutes() {
  const router = Router();
  router.get("/statutory-rules", permit("payroll.view"), async (req, res) => {
    res.json(await list(StatutoryRule, {}, req));
  });
  router.post(
    "/statutory-rules",
    permit("payroll.process"),
    async (req, res) => {
      const rule = input.parse(req.body);
      if (
        new Set(rule.wageComponents.map(normalize)).size !==
        rule.wageComponents.length
      )
        fail(422, "Use each wage component only once");
      if (rule.kind === "PT") {
        rule.slabs.sort((a, b) => a.minimumWage - b.minimumWage);
        if (
          rule.slabs[0].minimumWage !== 0 ||
          new Set(rule.slabs.map((slab) => slab.minimumWage)).size !==
            rule.slabs.length
        )
          fail(422, "Slabs must start at zero and have distinct minimum wages");
      }
      const saved = await transaction(async (session) => {
        if (
          await PayrollPeriod.exists({
            startDate: { $gte: rule.effectiveDate },
            status: { $ne: "Draft" },
          }).session(session)
        )
          fail(409, "A calculated payroll period locks this effective date");
        const [record] = await StatutoryRule.create([rule], { session });
        await audit(req, "statutory.rule.created", record.id, session);
        return record;
      });
      res.status(201).json({ data: saved });
    },
  );
  return router;
}
