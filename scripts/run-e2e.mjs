import mongoose from "mongoose";
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import { createApp } from "../src/app.js";
import { createInitialAdmin } from "../src/setup.js";
import { Employee, User, Role } from "../src/models.js";
import session from "express-session";
import { rm } from "node:fs/promises";
const frontendRoot = path.resolve(
  existsSync("../Frontend/package.json") ? "../Frontend" : "../frontend",
);
const resolveFrontend = createRequire(path.join(frontendRoot, "package.json"));
const { build } = await import(
  pathToFileURL(resolveFrontend.resolve("vite")).href
);
const dbName = `abco_test_${randomUUID().replaceAll("-", "")}`,
  password = randomBytes(20).toString("hex");
const storage = path.resolve("storage", dbName);
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
process.env.DOCUMENT_KEY = randomBytes(32).toString("hex");
process.env.DOCUMENT_STORAGE_PATH = storage;
process.env.FRONTEND_ORIGIN = "http://127.0.0.1:5190";
process.env.NODE_ENV = "test";
await mongoose.connect(
  `mongodb://127.0.0.1:${process.env.ABCO_TEST_MONGO_PORT || 27017}`,
  {
    dbName,
    serverSelectionTimeoutMS: 5000,
  },
);
let server;
try {
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  await createInitialAdmin({
    name: "Workspace Admin",
    email: "admin@example.test",
    password,
  });
  const employee = await Employee.create({
    code: "E2E-001",
    firstName: "Alice",
    lastName: "Tester",
    email: "alice@example.test",
    department: "Engineering",
    designation: "Developer",
    joiningDate: new Date("2025-01-01"),
  });
  const role = await Role.findOne({ name: "Employee" });
  await User.create({
    name: "Alice Tester",
    email: employee.email,
    passwordHash: await argon2.hash(password),
    role: role._id,
    employee: employee._id,
  });
  const webRoot = path.join(storage, "frontend");
  await build({
    configFile: path.join(frontendRoot, "vite.config.js"),
    root: frontendRoot,
    build: { outDir: webRoot, emptyOutDir: false },
  });
  const app = express();
  const api = createApp({ sessionStore: new session.MemoryStore() });
  app.use((req, res, next) =>
    req.path.startsWith("/api/") ? api(req, res, next) : next(),
  );
  app.use(express.static(webRoot));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
  server = app.listen(5190, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const child = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BASE_URL: "http://127.0.0.1:5190",
        E2E_PASSWORD: password,
        E2E_ADMIN_EMAIL: "admin@example.test",
        E2E_EMPLOYEE_EMAIL: "alice@example.test",
      },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  process.exitCode = code || 0;
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    if (
      mongoose.connection.name !== dbName ||
      !/^abco_test_[a-f\d]{32}$/.test(dbName)
    ) {
      console.error("Unsafe test database cleanup refused");
      process.exitCode = 1;
    } else await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (
    path.dirname(storage) !== path.resolve("storage") ||
    !path.basename(storage).startsWith("abco_test_")
  ) {
    console.error("Unsafe test storage cleanup refused");
    process.exitCode = 1;
  } else await rm(storage, { recursive: true, force: true });
}
