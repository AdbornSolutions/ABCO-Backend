import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";

const letterhead = readFileSync(new URL("./letterhead.png", import.meta.url));
const letterheadHeader = readFileSync(
  new URL("./letterhead-header.png", import.meta.url),
);
const money = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const formatAmount = (value) =>
  value == null ? "" : money.format(value / 100);

export function individualPayslipPDF(record) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: false,
    });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const title = new Intl.DateTimeFormat("en-IN", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${record.month}-01T00:00:00Z`));
    const employee = record.employeeSnapshot;
    const details = [
      ["Employee name", employee.name, "Employee ID", employee.code],
      ["PAN", employee.pan, "Date of joining", employee.joiningDate],
      ["Location", employee.location, "Bank A/C No.", employee.bankAccount],
      ["Designation", employee.designation, "Bank name", employee.bankName],
    ];
    const columns = [35, 150, 228, 303, 391, 467, 560];
    const rowCount = Math.max(record.earnings.length, record.deductions.length);
    const rowsPerPage = 12;

    function drawRow(values, y, height, bold = false) {
      pdf.font(bold ? "Times-Bold" : "Times-Roman").fontSize(10);
      values.forEach((value, index) => {
        pdf.text(value, columns[index] + 6, y + 5, {
          width: columns[index + 1] - columns[index] - 12,
          height: height - 5,
          ellipsis: true,
          align: [1, 2, 4, 5].includes(index) ? "right" : "left",
        });
      });
    }

    for (let offset = 0; offset < rowCount; offset += rowsPerPage) {
      pdf.addPage();
      pdf.image(letterhead, 0, 0, {
        width: pdf.page.width,
        height: pdf.page.height,
      });
      pdf.image(letterheadHeader, 0, 0, { width: pdf.page.width });
      pdf
        .font("Times-Bold")
        .fontSize(22)
        .fillColor("#151515")
        .text(`PAYSLIP FOR ${title.toUpperCase()}`, 25, 128, {
          width: 545,
          align: "center",
        });
      pdf.fontSize(11);
      details.forEach(([left, value, right, other], index) => {
        const y = 174 + index * 25;
        pdf.text(`${left.toUpperCase()}: ${value || "-"}`, 22, y, {
          width: 315,
          height: 24,
          ellipsis: true,
        });
        pdf.text(`${right.toUpperCase()}: ${other || "-"}`, 345, y, {
          width: 228,
          height: 24,
          ellipsis: true,
        });
      });

      const top = 285;
      const headerHeight = 32;
      const rowHeight = 30;
      const end = Math.min(offset + rowsPerPage, rowCount);
      const finalPage = end === rowCount;
      const footer = Math.max(
        top + headerHeight + rowHeight * (end - offset),
        635,
      );
      const bottom = footer + (finalPage ? 29 : 0);
      pdf
        .lineWidth(0.8)
        .strokeColor("#202020")
        .rect(columns[0], top, columns[6] - columns[0], bottom - top)
        .stroke();
      for (const x of [columns[3], columns[5]])
        pdf.moveTo(x, top).lineTo(x, bottom).stroke();
      pdf
        .moveTo(columns[0], top + headerHeight)
        .lineTo(columns[6], top + headerHeight)
        .stroke();
      drawRow(
        [
          "Particulars",
          "Gross (Rs.)",
          "Actual (Rs.)",
          "Deductions",
          "Amount (Rs.)",
          "Net (Rs.)",
        ],
        top,
        headerHeight,
        true,
      );
      for (let index = offset; index < end; index++) {
        const earning = record.earnings[index];
        const deduction = record.deductions[index];
        drawRow(
          [
            earning?.name || "",
            formatAmount(earning?.gross),
            formatAmount(earning?.actual),
            deduction?.name || "",
            formatAmount(deduction?.amount),
            "",
          ],
          top + headerHeight + (index - offset) * rowHeight,
          rowHeight,
        );
      }
      if (finalPage) {
        pdf.moveTo(columns[0], footer).lineTo(columns[6], footer).stroke();
        drawRow(
          [
            "Total",
            formatAmount(record.gross),
            formatAmount(record.actual),
            "",
            formatAmount(record.deductionsTotal),
            formatAmount(record.net),
          ],
          footer,
          29,
          true,
        );
        pdf.font("Times-Bold").fontSize(8).text("Human Resources", 36, 733);
      }
      pdf
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#d9362b")
        .text("Plot No. 47, Kotwal Nagar, Khamla, Nagpur - 440022", 46, 767)
        .text("hr-manager@abcocomputers.com", 46, 784)
        .text("www.abcocomputers.com", 46, 801);
    }
    pdf.end();
  });
}
