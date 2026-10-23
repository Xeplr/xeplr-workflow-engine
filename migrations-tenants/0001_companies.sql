-- 0001_companies.sql
-- companies — the top-level tenant (a customer of the workflow product). A
-- company is the hard multi-tenancy boundary: mtId1 = company.id on every
-- workspace-scoped row (see registerMTs() in db/setup.js — l1 = companyId).
-- Access grants live in the auth DB (userTenantsMapping), not filtered here.

CREATE TABLE "companies" (
  "id" varchar(25) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "code" varchar(50),
  "description" varchar(500),
  "isActive" boolean DEFAULT true,
  "mtId1" varchar(25),
  "mtId2" varchar(25),
  "mtId3" varchar(25),
  "mtId4" varchar(25),
  "recordCreatedDate" timestamp,
  "recordModifiedDate" timestamp,
  "recordCreatedBy" varchar(25),
  "recordModifiedBy" varchar(25)
);

CREATE INDEX "companies_code_index" ON "companies" ("code");
