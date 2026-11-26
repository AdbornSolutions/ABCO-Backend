import mongoose from "mongoose";
import { Router } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { CompanySettings } from "../operations/models.js";
import { toPaise } from "../payroll/calculator.js";
import {
  audit,
  date,
  fail,
  id,
  list,
  permit,
  text,
  transaction,
} from "../../shared/workflow.js";
import { workDate } from "../../security.js";

const { Schema } = mongoose;
const party = new Schema(
  { name: String, address: String, gstin: String },
  { _id: false },
);
const item = new Schema(
  {
    description: String,
    quantity: Number,
    unitPrice: Number,
    gstRate: Number,
    subtotal: Number,
    tax: Number,
  },
  { _id: false },
);
const payment = new Schema(
  {
    reference: String,
    date: String,
    amount: Number,
    actor: Schema.Types.ObjectId,
  },
  { _id: false },
);
const statuses = ["Unpaid", "Partially Paid", "Paid"];
const InvoiceSequence = mongoose.model(
  "InvoiceSequence",
  new Schema({
    _id: String,
    value: Number,
  }),
);
export const Invoice = mongoose.model(
  "Invoice",
  new Schema(
    {
      number: { type: String, unique: true, required: true },
      company: party,
      customer: party,
      invoiceDate: String,
      dueDate: String,
      items: [item],
      subtotal: Number,
      tax: Number,
      total: Number,
      paid: { type: Number, default: 0 },
      payments: [payment],
      status: { type: String, enum: statuses, default: "Unpaid", index: true },
      createdBy: Schema.Types.ObjectId,
    },
    { timestamps: true, strict: "throw", optimisticConcurrency: true },
  ),
);

const money = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an INR amount with up to two decimals")
  .transform(toPaise);
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
    "Enter a valid GSTIN format",
  );
const optionalGstin = z.union([gstin, z.literal("")]).optional();
const invoiceInput = z.object({
  invoiceDate: date,
  dueDate: date,
  companyGstin: optionalGstin,
  customer: z.object({
    name: text,
    address: z.string().trim().min(1).max(1500),
    gstin: optionalGstin,
  }),
  items: z
    .array(
      z.object({
        description: text,
        quantity: z.number().int().min(1).max(1000),
        unitPrice: money,
        gstRate: z.number().min(0).max(100).multipleOf(0.01),
      }),
    )
    .min(1)
    .max(30),
});
const paymentInput = z.object({
  reference: z.string().trim().min(1).max(120),
  date,
  amount: money.refine(
    (amount) => amount > 0,
    "Enter a positive payment amount",
  ),
});
const inr = (value) =>
  `INR ${(value / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function invoicePdf(res, invoice) {
  const pdf = new PDFDocument({ margin: 48, size: "A4" });
  res.attachment(invoice.number + ".pdf");
  pdf.pipe(res);
  pdf.fillColor("#0B1F3A").fontSize(22).text(invoice.company.name).fontSize(10);
  if (invoice.company.address) pdf.text(invoice.company.address);
  if (invoice.company.gstin) pdf.text("GSTIN " + invoice.company.gstin);
  pdf
    .moveDown()
    .fontSize(16)
    .text("Invoice " + invoice.number)
    .fontSize(10)
    .text(`Issued ${invoice.invoiceDate}    Due ${invoice.dueDate}`);
  pdf
    .moveDown()
    .text("Bill to")
    .fontSize(13)
    .text(invoice.customer.name)
    .fontSize(10)
    .text(invoice.customer.address);
  if (invoice.customer.gstin) pdf.text("GSTIN " + invoice.customer.gstin);
  pdf.moveDown();
  for (const [index, line] of invoice.items.entries()) {
    if (pdf.y > 685) pdf.addPage();
    pdf
      .font("Helvetica-Bold")
      .text(`${index + 1}. ${line.description}`)
      .font("Helvetica")
      .text(
        `${line.quantity} × ${inr(line.unitPrice)}    GST ${line.gstRate}% (${inr(line.tax)})    ${inr(line.subtotal + line.tax)}`,
      )
      .moveDown(0.5);
  }
  if (pdf.y > 650) pdf.addPage();
  pdf
    .moveDown()
    .text("Subtotal  " + inr(invoice.subtotal), { align: "right" })
    .text("GST  " + inr(invoice.tax), { align: "right" })
    .font("Helvetica-Bold")
    .text("Total  " + inr(invoice.total), { align: "right" })
    .font("Helvetica")
    .text("Paid  " + inr(invoice.paid), { align: "right" })
    .text("Balance  " + inr(invoice.total - invoice.paid), { align: "right" });
  pdf.end();
}

export function invoiceRoutes() {
  const router = Router();
  router.use("/invoices", permit("invoices.manage"));
  router.get("/invoices", async (req, res) => {
    const { status, search } = z
      .object({
        status: z.enum(statuses).optional(),
        search: z.string().trim().max(100).optional(),
      })
      .parse(req.query);
    const filter = status ? { status } : {};
    if (search) {
      const match = { $regex: RegExp.escape(search), $options: "i" };
      filter.$or = [{ number: match }, { "customer.name": match }];
    }
    res.json(await list(Invoice, filter, req));
  });
  router.post("/invoices", async (req, res) => {
    const input = invoiceInput.parse(req.body);
    if (input.dueDate < input.invoiceDate)
      fail(422, "Due date precedes invoice date");
    if (input.items.some((line) => line.gstRate) && !input.companyGstin)
      fail(422, "Enter the company's GSTIN when charging GST");
    const settings = await CompanySettings.findById("company").lean();
    const items = input.items.map((line) => {
      const subtotal = line.quantity * line.unitPrice;
      const basisPoints = Math.round(line.gstRate * 100);
      const tax = Number(
        (BigInt(subtotal) * BigInt(basisPoints) + 5000n) / 10000n,
      );
      return { ...line, subtotal, tax };
    });
    const subtotal = items.reduce((sum, line) => sum + line.subtotal, 0);
    const tax = items.reduce((sum, line) => sum + line.tax, 0);
    const total = subtotal + tax;
    if (!total) fail(422, "Invoice total must be positive");
    const year = input.invoiceDate.slice(0, 4);
    const invoice = await transaction(async (session) => {
      const sequence = await InvoiceSequence.findByIdAndUpdate(
        year,
        { $inc: { value: 1 } },
        { upsert: true, new: true, session },
      );
      if (sequence.value > 9999999)
        fail(409, "Invoice sequence exhausted for this year");
      const [record] = await Invoice.create(
        [
          {
            number: `INV-${year}-${String(sequence.value).padStart(7, "0")}`,
            company: {
              name: settings?.name || "ABCO Computers",
              address: settings?.address,
              gstin: input.companyGstin,
            },
            customer: input.customer,
            invoiceDate: input.invoiceDate,
            dueDate: input.dueDate,
            items,
            subtotal,
            tax,
            total,
            createdBy: req.user._id,
          },
        ],
        { session },
      );
      await audit(req, "invoice.created", record.id, session);
      return record;
    });
    res.status(201).json({ data: invoice });
  });
  router.post("/invoices/:id/payments", async (req, res) => {
    const identifier = id.parse(req.params.id);
    const input = paymentInput.parse(req.body);
    if (input.date > workDate())
      fail(422, "Payment date cannot be in the future");
    const invoice = await transaction(async (session) => {
      const record = await Invoice.findById(identifier).session(session);
      if (!record) fail(404, "Invoice not found");
      const existing = record.payments.find(
        (entry) => entry.reference === input.reference,
      );
      if (existing) {
        if (existing.amount !== input.amount || existing.date !== input.date)
          fail(409, "This payment reference is already in use");
        return record;
      }
      if (record.payments.length >= 100)
        fail(409, "Invoice payment limit reached");
      if (input.amount > record.total - record.paid)
        fail(422, "Payment exceeds outstanding balance");
      record.payments.push({ ...input, actor: req.user._id });
      record.paid += input.amount;
      record.status = record.paid === record.total ? "Paid" : "Partially Paid";
      await record.save({ session });
      await audit(req, "invoice.payment.recorded", record.id, session);
      return record;
    });
    res.json({ data: invoice });
  });
  router.get("/invoices/:id/pdf", async (req, res) => {
    const invoice = await Invoice.findById(id.parse(req.params.id)).lean();
    if (!invoice) fail(404, "Invoice not found");
    await audit(req, "invoice.downloaded", invoice._id);
    invoicePdf(res, invoice);
  });
  return router;
}
