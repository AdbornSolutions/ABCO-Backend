import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import { Employee } from "../../models.js";
import { scopedModel } from "../../shared/scope.js";
import {
  audit,
  date,
  fail,
  id,
  ownEmployee,
  permit,
  transaction,
} from "../../shared/workflow.js";

const { Schema } = mongoose;
const education = new Schema(
  { institution: String, qualification: String, completedYear: Number },
  { _id: false },
);
const employment = new Schema(
  { employer: String, title: String, from: String, to: String },
  { _id: false },
);
export const EmployeeBackground = scopedModel(
  "EmployeeBackground",
  new Schema(
    {
      employee: {
        type: Schema.Types.ObjectId,
        ref: "Employee",
        required: true,
        unique: true,
      },
      education: [education],
      employment: [employment],
      revision: { type: Number, default: 1 },
    },
    { timestamps: true, strict: "throw", optimisticConcurrency: true },
  ),
);

const label = z.string().trim().min(1).max(180);
const input = z.object({
  revision: z.number().int().nonnegative(),
  education: z
    .array(
      z.object({
        institution: label,
        qualification: label,
        completedYear: z.number().int().min(1900).max(2100),
      }),
    )
    .max(30),
  employment: z
    .array(
      z
        .object({
          employer: label,
          title: label,
          from: date,
          to: date,
        })
        .refine(
          (entry) => entry.to >= entry.from,
          "Employment end date precedes start date",
        ),
    )
    .max(50),
});
const empty = { education: [], employment: [], revision: 0 };

export function employeeBackgroundRoutes() {
  const router = Router();
  router.get("/employees/me/background", async (req, res) => {
    const record = await EmployeeBackground.findOne({
      employee: ownEmployee(req),
    }).lean();
    res.json({ data: record || empty });
  });
  router.get(
    "/employees/:id/background",
    permit("employee.records"),
    async (req, res) => {
      const employee = id.parse(req.params.id);
      if (!(await Employee.exists({ _id: employee })))
        fail(404, "Employee not found");
      const record = await EmployeeBackground.findOne({ employee }).lean();
      res.json({ data: record || empty });
    },
  );
  router.patch(
    "/employees/:id/background",
    permit("employee.records"),
    async (req, res) => {
      const employee = id.parse(req.params.id);
      const { revision, ...records } = input.parse(req.body);
      const saved = await transaction(async (session) => {
        if (!(await Employee.exists({ _id: employee }).session(session)))
          fail(404, "Employee not found");
        let record = await EmployeeBackground.findOne({ employee }).session(
          session,
        );
        if ((record?.revision || 0) !== revision)
          fail(409, "This history changed. Refresh before saving.");
        if (record) record.set({ ...records, revision: revision + 1 });
        else record = new EmployeeBackground({ employee, ...records });
        await record.save({ session });
        await audit(req, "employee.background.updated", employee, session);
        return record;
      });
      res.json({ data: saved });
    },
  );
  return router;
}
