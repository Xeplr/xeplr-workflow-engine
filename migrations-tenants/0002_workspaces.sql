-- 0002_workspaces.sql
-- workspaces — the second tenancy level, under a company (mtId2 on every row
-- that lives inside one). Where a team's workflows are organised.

CREATE TABLE "workspaces" (
  "id" varchar(25) PRIMARY KEY,
  "companyId" varchar(25) NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" varchar(500),
  "tags" jsonb,
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

CREATE INDEX "workspaces_company_index" ON "workspaces" ("companyId");
