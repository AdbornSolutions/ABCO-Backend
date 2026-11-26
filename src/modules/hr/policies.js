import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import { can } from "../../security.js";
import {
  audit,
  fail,
  id,
  list,
  ownEmployee,
  permit,
  transaction,
} from "../../shared/workflow.js";

const { Schema } = mongoose;
const categories = [
  "Leave",
  "Attendance",
  "Work from home",
  "Code of conduct",
  "Payroll",
  "Handbook",
  "Other",
];
const content = {
  title: { type: String, required: true },
  category: { type: String, enum: categories, required: true },
  body: { type: String, required: true },
};
const draft = new Schema(content, { _id: false });
const version = new Schema(
  {
    ...content,
    version: Number,
    publishedAt: Date,
    publishedBy: Schema.Types.ObjectId,
  },
  { _id: false },
);
export const HrPolicy = mongoose.model(
  "HrPolicy",
  new Schema(
    {
      draft,
      current: version,
      history: [version],
    },
    { timestamps: true, strict: "throw", optimisticConcurrency: true },
  ),
);
const acknowledgement = new Schema(
  {
    policy: { type: Schema.Types.ObjectId, ref: "HrPolicy", required: true },
    version: { type: Number, required: true },
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
  },
  { timestamps: true, strict: "throw" },
);
acknowledgement.index({ policy: 1, version: 1, employee: 1 }, { unique: true });
export const PolicyAcknowledgement = mongoose.model(
  "PolicyAcknowledgement",
  acknowledgement,
);

const policyInput = z.object({
  title: z.string().trim().min(1).max(180),
  category: z.enum(categories),
  body: z.string().trim().min(3).max(20000),
});

export function policyRoutes() {
  const router = Router();
  const manage = permit("policies.manage");
  router.get("/hr-policies", async (req, res) => {
    const isManager = can(req.user, "policies.manage");
    const result = await list(
      HrPolicy,
      isManager ? {} : { "current.version": { $exists: true } },
      req,
      {
        select: isManager ? "draft current updatedAt __v" : "current updatedAt",
      },
    );
    const employee = req.user.employee;
    const accepted = employee
      ? await PolicyAcknowledgement.find({
          policy: { $in: result.data.map((policy) => policy._id) },
          employee,
        })
          .select("policy version")
          .lean()
      : [];
    result.data = result.data.map((policy) => ({
      ...policy,
      acknowledged: accepted.some(
        (entry) =>
          String(entry.policy) === String(policy._id) &&
          entry.version === policy.current?.version,
      ),
    }));
    res.json(result);
  });
  router.post("/hr-policies", manage, async (req, res) => {
    const input = policyInput.parse(req.body);
    const record = await transaction(async (session) => {
      const [policy] = await HrPolicy.create([{ draft: input }], { session });
      await audit(req, "policy.created", policy.id, session);
      return policy;
    });
    res.status(201).json({ data: record });
  });
  router.patch("/hr-policies/:id/draft", manage, async (req, res) => {
    const identifier = id.parse(req.params.id);
    const input = policyInput
      .extend({ revision: z.number().int().min(0) })
      .parse(req.body);
    const { revision, ...draft } = input;
    const record = await transaction(async (session) => {
      const policy = await HrPolicy.findById(identifier).session(session);
      if (!policy) fail(404, "Policy not found");
      if (policy.__v !== revision)
        fail(409, "Policy changed. Refresh before editing");
      policy.draft = draft;
      await policy.save({ session });
      await audit(req, "policy.draft.updated", policy.id, session);
      return policy;
    });
    res.json({ data: record });
  });
  router.post("/hr-policies/:id/publish", manage, async (req, res) => {
    const identifier = id.parse(req.params.id);
    const { revision } = z
      .object({ revision: z.number().int().min(0) })
      .parse(req.body);
    const record = await transaction(async (session) => {
      const policy = await HrPolicy.findById(identifier).session(session);
      if (!policy) fail(404, "Policy not found");
      if (policy.__v !== revision || !policy.draft)
        fail(409, "Draft changed. Refresh before publishing");
      if (policy.history.length >= 99)
        fail(409, "Policy has reached 100 versions");
      if (policy.current) policy.history.push(policy.current.toObject());
      policy.current = {
        ...policy.draft.toObject(),
        version: (policy.current?.version || 0) + 1,
        publishedAt: new Date(),
        publishedBy: req.user._id,
      };
      policy.draft = undefined;
      await policy.save({ session });
      await audit(req, "policy.published", policy.id, session);
      return policy;
    });
    res.json({ data: record });
  });
  router.post("/hr-policies/:id/acknowledge", async (req, res) => {
    const policy = id.parse(req.params.id);
    const employee = ownEmployee(req);
    const { version } = z
      .object({ version: z.number().int().positive() })
      .parse(req.body);
    await transaction(async (session) => {
      if (
        !(await HrPolicy.exists({
          _id: policy,
          "current.version": version,
        }).session(session))
      )
        fail(
          409,
          "A newer policy version may be available. Refresh and review it",
        );
      const result = await PolicyAcknowledgement.updateOne(
        { policy, version, employee },
        {
          $setOnInsert: {
            policy,
            version,
            employee,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true, session, timestamps: false },
      );
      if (result.upsertedCount)
        await audit(req, "policy.acknowledged", policy, session);
    });
    res.json({ data: true });
  });
  router.get("/hr-policies/:id/versions", manage, async (req, res) => {
    const policy = await HrPolicy.findById(id.parse(req.params.id))
      .select("history current")
      .lean();
    if (!policy) fail(404, "Policy not found");
    res.json({
      data: [policy.current, ...policy.history.reverse()].filter(Boolean),
    });
  });
  router.get("/hr-policies/:id/acknowledgements", manage, async (req, res) => {
    const policy = id.parse(req.params.id);
    const version = z.coerce.number().int().positive().parse(req.query.version);
    res.json(
      await list(PolicyAcknowledgement, { policy, version }, req, {
        populate: { path: "employee", select: "code firstName lastName" },
      }),
    );
  });
  return router;
}
