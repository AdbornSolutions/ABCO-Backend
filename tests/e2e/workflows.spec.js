import { test, expect } from "@playwright/test";
const password = process.env.E2E_PASSWORD;
test("expanded HRMS workspaces load real data without browser errors", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  for (const [path, title] of [
    ["/projects", "Projects"],
    ["/timesheets", "Timesheets"],
    ["/training", "Training & development"],
    ["/training-enrollments", "Learning progress"],
    ["/skills", "Skills & capability"],
    ["/expenses", "Expenses & reimbursements"],
    ["/expense-policies", "Expense policies"],
    ["/travel", "Travel & visits"],
    ["/surveys", "Employee surveys"],
    ["/recognitions", "Recognition & rewards"],
    ["/approval-workflows", "Approval workflows"],
    ["/approvals", "Approval inbox"],
    ["/approval-delegations", "Approval delegation"],
    ["/peer-feedback", "360-degree feedback"],
    ["/improvement-plans", "Performance improvement plans"],
    ["/appraisal-recommendations", "Appraisal recommendations"],
    ["/document-templates", "Document templates"],
    ["/generated-letters", "Official letters"],
    ["/invoices", "Invoices"],
    ["/hr-policies", "HR policies"],
    ["/employee-id-cards", "Employee ID cards"],
    ["/statutory-rules", "PF & PT rules"],
    ["/statutory-reports", "PF & PT reports"],
    ["/asset-maintenance", "Asset maintenance"],
    ["/loans", "Loans & salary advances"],
    ["/loan-policies", "Loan & advance policies"],
    ["/final-settlements", "Full & final settlements"],
    ["/shift-swaps", "Shift swap requests"],
    ["/calendar", "Team calendar"],
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".loading")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await page.getByLabel("Calendar type").selectOption("Shifts");
  await expect(page.getByText("Loading calendar…")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/calendar-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
async function login(page, employee = false) {
  await page.goto("/");
  await page
    .getByLabel("Work email")
    .fill(
      employee ? process.env.E2E_EMPLOYEE_EMAIL : process.env.E2E_ADMIN_EMAIL,
    );
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon)/ }),
  ).toBeVisible();
}
test("login, dashboard, navigation and logout", async ({ page }) => {
  await login(page);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(
    navigation.getByRole("button", { name: "Payroll & finance" }),
  ).toHaveAttribute("aria-expanded", "false");
  await navigation.getByRole("button", { name: "Payroll & finance" }).click();
  await expect(
    navigation.getByRole("link", { name: "Invoices", exact: true }),
  ).toBeVisible();
  await navigation
    .getByRole("button", { name: "Documents & policies" })
    .click();
  await expect(
    navigation.getByRole("link", { name: "Invoices", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Notifications", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Logout", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".punch-card")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "My profile", exact: true }),
  ).toHaveCount(0);
  await page.goto("/attendance");
  await expect(
    page.getByRole("heading", { name: "Attendance", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".punch-card")).toHaveCount(0);
  await page.goto("/leaves");
  await expect(
    page.getByRole("button", { name: "Request time off", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "My requests", exact: true }),
  ).toHaveCount(0);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Upcoming", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  for (const [path, title] of [
    ["/tasks", "Tasks & work"],
    ["/daily-reports", "Daily work reports"],
    ["/announcements", "Company announcements"],
    ["/helpdesk", "Helpdesk"],
    ["/jobs", "Job openings"],
    ["/candidates", "Candidate pipeline"],
    ["/onboarding", "Employee onboarding"],
    ["/performance", "Performance & growth"],
    ["/assets", "Assets & equipment"],
    ["/exits", "Exit & offboarding"],
    ["/documents", "Documents"],
    ["/notifications", "Notifications"],
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "Logout", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in to workspace" }),
  ).toBeVisible();
});
test("HR creates an employee through the directory drawer", async ({
  page,
}) => {
  await login(page);
  await page.goto("/employees");
  await page.getByRole("button", { name: "Add employee", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("First name").fill("Browser");
  await dialog.getByLabel("Last name").fill("Colleague");
  await dialog.getByLabel("Work email").fill("browser-colleague@example.test");
  await dialog.getByLabel("Department", { exact: true }).fill("Operations");
  await dialog.getByLabel("Designation").fill("Analyst");
  await dialog.getByLabel("Branch", { exact: true }).fill("Head office");
  await dialog.getByRole("button", { name: "Add employee" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("browser-colleague@example.test", { exact: true }),
  ).toBeVisible();
});
test("manager assigns a task and employee completes the connected daily workflow", async ({
  browser,
  page,
}) => {
  await login(page);
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Assign task" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Task title").fill("Browser delivery task");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Verify the connected employee workflow");
  await dialog
    .getByLabel("Employee", { exact: true })
    .selectOption({ label: "Alice Tester · E2E-001" });
  const today = new Date().toISOString().slice(0, 10);
  await dialog.getByLabel("Due date").fill(today);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const context = await browser.newContext();
  const employee = await context.newPage();
  await login(employee, true);
  await employee.goto("/attendance");
  await employee.getByRole("button", { name: "Punch in", exact: true }).click();
  await expect(
    employee.getByText("You’re checked in", { exact: true }),
  ).toBeVisible();
  await employee.goto("/tasks");
  const row = employee
    .getByRole("row")
    .filter({ hasText: "Browser delivery task" });
  await row.getByRole("button", { name: "Update status" }).click();
  dialog = employee.getByRole("dialog");
  await dialog
    .getByLabel("Status", { exact: true })
    .selectOption("In Progress");
  await dialog.getByRole("button", { name: "Update status" }).click();
  await expect(dialog).not.toBeVisible();
  await employee.goto("/daily-reports");
  await employee.getByRole("button", { name: "Write report" }).click();
  dialog = employee.getByRole("dialog");
  await dialog.getByLabel("Work summary").fill("Connected browser workflow");
  await dialog
    .getByLabel("Work status", { exact: true })
    .selectOption("Completed");
  await dialog
    .getByLabel("What did you accomplish?")
    .fill("Completed the browser workflow and verified report submission");
  await dialog.getByLabel("Time spent (minutes)").fill("60");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await employee
    .getByRole("row")
    .filter({ hasText: "Connected browser workflow" })
    .getByRole("button", { name: "Submit report" })
    .click();
  await employee
    .getByRole("dialog")
    .getByRole("button", { name: "Submit report" })
    .click();
  await expect(employee.getByRole("dialog")).not.toBeVisible();
  await employee.goto("/attendance");
  await employee
    .getByRole("button", { name: "Punch out", exact: true })
    .click();
  await expect(
    employee.getByText("Workday complete", { exact: true }),
  ).toBeVisible();
  await context.close();
});
test("private document upload and authorized download work from the UI", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents");
  await page.getByRole("button", { name: "Upload document" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Employee", { exact: true })
    .selectOption({ label: "Alice Tester · E2E-001" });
  await dialog.getByLabel("Document name").fill("Browser employment letter");
  await dialog
    .getByLabel("Category", { exact: true })
    .selectOption("Employment Letters");
  await dialog
    .getByLabel("File (PDF, DOCX, XLSX, PNG or JPEG, max 8 MB)")
    .setInputFiles({
      name: "letter.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF"),
    });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const row = page
    .getByRole("row")
    .filter({ hasText: "Browser employment letter" });
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const file = await downloadPromise;
  expect(file.suggestedFilename()).toBe("Browser employment letter.pdf");
});
test("salary form uses component rows and saves real amounts", async ({
  page,
}) => {
  await login(page);
  await page.goto("/payroll");
  await page
    .getByRole("button", { name: "Salary structures", exact: true })
    .click();
  await page.getByRole("button", { name: "Assign salary structure" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Employee", { exact: true })
    .selectOption({ label: "Alice Tester · E2E-001" });
  const now = new Date(),
    date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 10);
  await dialog.getByLabel("Effective from").fill(date);
  await dialog.getByLabel("Monthly amount (INR)").fill("30000.00");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Alice Tester" }),
  ).toContainText("30,000");
});
test("finance creates, filters and downloads an invoice", async ({ page }) => {
  await login(page);
  await page.goto("/invoices");
  await page.getByRole("button", { name: "Create invoice" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Due date").fill("2099-12-31");
  await dialog.getByLabel("Customer name").fill("Browser Customer");
  await dialog.getByLabel("Billing address").fill("1 Test Road");
  await dialog.getByLabel("Item or service").fill("Consulting");
  await dialog.getByLabel("Unit price (INR)").fill("1250.00");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel("Invoice or customer").fill("Browser Customer");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const row = page.getByRole("row").filter({ hasText: "Browser Customer" });
  await expect(row).toContainText("1,250.00");
  const pending = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download PDF" }).click();
  expect((await pending).suggestedFilename()).toMatch(/^INV-\d{4}-\d{7}\.pdf$/);
});
test("mobile layout keeps primary controls and navigation reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(
    page.getByRole("button", { name: "Logout", exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "People operations" }).click();
  await expect(
    page.getByRole("link", { name: "Assets & equipment", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Assets & equipment", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Assets & equipment" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/mobile-assets.png",
    fullPage: true,
  });
});
