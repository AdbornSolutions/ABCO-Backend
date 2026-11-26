import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { Router } from "express";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { z } from "zod";
import { Employee } from "../../models.js";
import { can } from "../../security.js";
import { scopedModel } from "../../shared/scope.js";
import {
  audit,
  fail,
  id,
  list,
  permit,
  transaction,
} from "../../shared/workflow.js";
import { Document, readStoredVersion } from "../documents/routes.js";
import { CompanySettings } from "../operations/models.js";
import { Onboarding } from "./models.js";

const { Schema } = mongoose;
const permission = "onboarding.manage";
export const EmployeeCard = scopedModel(
  "EmployeeCard",
  new Schema(
    {
      employee: {
        type: Schema.Types.ObjectId,
        ref: "Employee",
        unique: true,
        required: true,
      },
      token: { type: String, unique: true, select: false, required: true },
      version: Number,
      code: String,
      name: String,
      department: String,
      designation: String,
      joined: String,
      phone: String,
      company: { name: String, logo: String },
      photo: {
        document: Schema.Types.ObjectId,
        version: Schema.Types.ObjectId,
      },
    },
    { timestamps: true, strict: "throw" },
  ),
);

export async function issueEmployeeCard(
  req,
  employeeId,
  session,
  showContact = false,
) {
  const employee = await Employee.findById(employeeId).session(session);
  if (!employee || employee.status === "Archived")
    fail(409, "ID cards require an active employee");
  const company = await CompanySettings.findById("company")
    .session(session)
    .lean();
  const photograph = await Document.findOne({
    employee: employeeId,
    category: "Employee Photograph",
    status: "Verified",
    visibility: "Employee",
  })
    .sort({ updatedAt: -1 })
    .session(session);
  const picture = photograph?.versions.at(-1);
  const photo =
    picture && ["image/jpeg", "image/png"].includes(picture.mime)
      ? { document: photograph._id, version: picture._id }
      : null;
  const card = await EmployeeCard.findOneAndUpdate(
    { employee: employeeId },
    {
      $set: {
        token: randomBytes(24).toString("hex"),
        code: employee.code,
        name: `${employee.firstName} ${employee.lastName || ""}`.trim(),
        department: employee.department,
        designation: employee.designation,
        joined: employee.joiningDate?.toISOString().slice(0, 10) || "",
        phone: (showContact && employee.phone) || "",
        company: {
          name: company?.name || "ABCO Computers",
          logo: company?.logo,
        },
        photo,
      },
      $inc: { version: 1 },
    },
    { upsert: true, new: true, session },
  );
  await audit(req, "employee.card.issued", card.id, session);
  return card.id;
}

async function activeCard(req, filter, includeToken = false) {
  if (!can(req.user, permission)) {
    if (!req.user.employee) fail(404, "Active employee card not found");
    filter.employee = req.user.employee;
  }
  let query = EmployeeCard.findOne(filter);
  if (includeToken) query = query.select("+token");
  const card = await query.lean();
  if (
    !card ||
    !(await Employee.exists({
      _id: card.employee,
      status: { $ne: "Archived" },
    }))
  )
    fail(404, "Active employee card not found");
  return card;
}

async function cardPdf(req, res, card) {
  const origin = process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5180";
  const qr = await QRCode.toBuffer(
    `${origin.replace(/\/$/, "")}/employee-id-cards#${card.token}`,
    { margin: 1 },
  );
  const photograph =
    card.photo?.document &&
    (await Document.findOne({
      _id: card.photo.document,
      employee: card.employee,
      status: "Verified",
      visibility: "Employee",
    }));
  const version = photograph?.versions.id(card.photo.version);
  const image = version && (await readStoredVersion(version));
  await audit(req, "employee.card.viewed", card._id);
  const pdf = new PDFDocument({ size: [350, 220], margin: 17 });
  res
    .type("pdf")
    .set("Content-Disposition", 'inline; filename="employee-id-card.pdf"');
  pdf.pipe(res);
  pdf.rect(0, 0, 350, 52).fill("#0B1F3A");
  const companyLogo = card.company?.logo?.match(
    /^data:image\/png;base64,(.+)$/,
  );
  if (companyLogo)
    pdf.image(Buffer.from(companyLogo[1], "base64"), 17, 10, { fit: [31, 31] });
  pdf
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(card.company.name, companyLogo ? 57 : 17, 17, {
      width: 245,
      ellipsis: true,
      lineBreak: false,
    });
  pdf.fillColor("#0B1F3A").fontSize(10).text("EMPLOYEE IDENTITY CARD", 17, 64);
  pdf.roundedRect(17, 85, 58, 73, 6).fill("#E7EDF5");
  if (image)
    pdf.image(image, 18, 86, {
      fit: [56, 71],
      align: "center",
      valign: "center",
    });
  else
    pdf
      .fillColor("#48566B")
      .fontSize(17)
      .text(
        card.name
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join(""),
        18,
        112,
        { width: 56, align: "center" },
      );
  pdf
    .fillColor("#0B1F3A")
    .fontSize(14)
    .text(card.name, 86, 87, { width: 171, ellipsis: true, lineBreak: false });
  pdf.font("Helvetica").fontSize(10);
  [
    card.code,
    card.designation,
    card.department,
    card.joined && "Joined " + card.joined,
    card.phone,
  ]
    .filter(Boolean)
    .forEach((line, index) =>
      pdf.text(line, 86, 109 + index * 13, {
        width: 169,
        ellipsis: true,
        lineBreak: false,
      }),
    );
  pdf.image(qr, 260, 92, { width: 72 });
  pdf
    .fontSize(8)
    .text("Verify identity", 260, 168, { width: 72, align: "center" });
  pdf.fillColor("#48566B").text("Card version " + card.version, 17, 194);
  pdf.end();
}

export function employeeCardRoutes() {
  const router = Router();
  router.get("/employee-id-cards", async (req, res) => {
    const filter = can(req.user, permission)
      ? {}
      : { employee: req.user.employee || null };
    res.json(
      await list(EmployeeCard, filter, req, {
        select:
          "employee version name code designation department joined createdAt",
      }),
    );
  });
  router.get("/employee-id-cards/verify", async (req, res) => {
    const token = z
      .string()
      .regex(/^[a-f\d]{48}$/)
      .parse(req.query.token);
    const card = await activeCard(req, { token });
    res.json({
      data: { code: card.code, name: card.name, version: card.version },
    });
  });
  router.get("/employee-id-cards/:id/pdf", async (req, res) => {
    const card = await activeCard(req, { _id: id.parse(req.params.id) }, true);
    await cardPdf(req, res, card);
  });
  router.post(
    "/employee-id-cards/regenerate",
    permit(permission),
    async (req, res) => {
      const { employee, includeContact } = z
        .object({ employee: id, includeContact: z.boolean().default(false) })
        .parse(req.body);
      const card = await transaction(async (session) => {
        if (
          !(await Onboarding.exists({ employee, status: "Completed" }).session(
            session,
          ))
        )
          fail(409, "Complete onboarding before issuing an ID card");
        return issueEmployeeCard(req, employee, session, includeContact);
      });
      res.json({ data: { id: card } });
    },
  );
  return router;
}
