import { Router } from "express";
import { Audit, Employee, Leave, User } from "../../models.js";
import { can } from "../../security.js";
import { Document } from "../documents/routes.js";
import { Expense } from "../extended/models.js";
import { Invoice } from "../finance/invoices.js";
import { Candidate, Onboarding, Performance } from "../hr/models.js";
import { DailyReport, Task } from "../operations/models.js";
import { PayrollEntry, PayrollPeriod } from "../payroll/models.js";

const openTasks = {
  archived: { $ne: true },
  status: { $nin: ["Completed", "Cancelled"] },
};
const roleCards = {
  "Super Admin": ["accounts", "audit", "onboarding", "payrollApproval"],
  Admin: ["audit", "onboarding", "documents"],
  "HR Manager": ["onboarding", "documents", "candidates", "leave"],
  "HR Executive": ["documents", "probation"],
  "Department Manager": ["leave", "reviews", "teamTasks"],
  "Team Leader": ["teamTasks", "reports", "leave"],
  "Payroll / Finance": ["payrollProcessing", "invoices", "expenses"],
  "Payroll Approver": ["payrollApproval", "releasedPeriods"],
  Employee: ["myTasks", "myLeave", "myPayslips"],
};

export function workspaceDashboardRoutes() {
  const router = Router();
  router.get("/dashboard/workspace", async (req, res) => {
    const { user } = req;
    const employee = user.employee;
    const released = { status: { $in: ["Finalized", "Paid", "Closed"] } };
    const definitions = {
      accounts: [
        "Active accounts",
        "/settings",
        "roles.manage",
        () => User.countDocuments({ active: true }),
      ],
      audit: [
        "Audit events in the last 7 days",
        "/audit",
        "audit.read",
        () =>
          Audit.countDocuments({
            createdAt: { $gte: new Date(Date.now() - 7 * 86400000) },
          }),
      ],
      probation: [
        "Employees on probation",
        "/employees",
        "employee.read",
        () => Employee.countDocuments({ status: "Probation" }),
      ],
      onboarding: [
        "Onboarding in progress",
        "/onboarding",
        "onboarding.manage",
        () => Onboarding.countDocuments({ status: "In Progress" }),
      ],
      documents: [
        "Documents awaiting verification",
        "/documents",
        "documents.manage",
        () =>
          Document.countDocuments({
            employee: { $ne: null },
            status: "Pending",
          }),
      ],
      candidates: [
        "Candidates in early review",
        "/candidates",
        "recruitment.manage",
        () =>
          Candidate.countDocuments({
            status: { $in: ["Applied", "Screening", "Interview"] },
          }),
      ],
      leave: [
        "Leave requests awaiting review",
        "/leaves",
        "leave.approve",
        () => Leave.countDocuments({ status: "Pending" }),
      ],
      reviews: [
        "Open performance reviews",
        "/performance",
        "performance.manage",
        () =>
          Performance.countDocuments({
            status: {
              $in: [
                "Goals Assigned",
                "Self Review Submitted",
                "Manager Reviewed",
              ],
            },
          }),
      ],
      teamTasks: [
        "Open team tasks",
        "/tasks",
        "tasks.manage",
        () => Task.countDocuments(openTasks),
      ],
      reports: [
        "Work reports awaiting review",
        "/daily-reports",
        "reports.review",
        () => DailyReport.countDocuments({ status: "Submitted" }),
      ],
      payrollProcessing: [
        "Payroll periods to prepare",
        "/payroll",
        "payroll.process",
        () =>
          PayrollPeriod.countDocuments({
            status: { $in: ["Draft", "Calculated"] },
          }),
      ],
      payrollApproval: [
        "Payroll periods awaiting approval",
        "/payroll",
        "payroll.approve",
        () => PayrollPeriod.countDocuments({ status: "Under Review" }),
      ],
      releasedPeriods: [
        "Released payroll periods",
        "/payroll",
        "payroll.view",
        () => PayrollPeriod.countDocuments(released),
      ],
      invoices: [
        "Invoices with a balance",
        "/invoices",
        "invoices.manage",
        () =>
          Invoice.countDocuments({
            status: { $in: ["Unpaid", "Partially Paid"] },
          }),
      ],
      expenses: [
        "Submitted expense claims",
        "/expenses",
        "expenses.approve",
        () => Expense.countDocuments({ status: "Submitted" }),
      ],
      myTasks: [
        "My open tasks",
        "/tasks",
        null,
        () => Task.countDocuments({ ...openTasks, employee }),
      ],
      myLeave: [
        "My pending leave requests",
        "/leaves",
        null,
        () => Leave.countDocuments({ employee, status: "Pending" }),
      ],
      myPayslips: [
        "Available payslips",
        "/payroll",
        null,
        async () => {
          const periods = await PayrollPeriod.distinct("_id", released);
          return PayrollEntry.countDocuments({
            employee,
            period: { $in: periods },
          });
        },
      ],
    };
    const keys = Object.hasOwn(roleCards, user.role?.name)
      ? roleCards[user.role.name]
      : Object.keys(definitions);
    const visible = keys
      .filter((key) => {
        const permission = definitions[key][2];
        return permission ? can(user, permission) : Boolean(employee);
      })
      .slice(0, 4);
    const cards = await Promise.all(
      visible.map(async (key) => {
        const [label, path, , count] = definitions[key];
        return { key, label, path, count: await count() };
      }),
    );
    res.json({ data: { cards } });
  });
  return router;
}
