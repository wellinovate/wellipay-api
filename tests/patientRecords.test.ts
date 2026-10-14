import { describe, it, expect } from "vitest";
import { createPatientRecordSchema, listPatientRecordsQuerySchema } from "../src/schemas/patientRecords.js";

describe("createPatientRecordSchema", () => {
  it("accepts a name alone", () => {
    expect(createPatientRecordSchema.safeParse({ fullName: "Blessing Kalu" }).success).toBe(true);
  });
  it("rejects a one-letter name", () => {
    expect(createPatientRecordSchema.safeParse({ fullName: "B" }).success).toBe(false);
  });
  it("rejects a bad email", () => {
    expect(createPatientRecordSchema.safeParse({ fullName: "Blessing Kalu", email: "nope" }).success).toBe(false);
  });
  it("rejects a patientRef with spaces", () => {
    expect(createPatientRecordSchema.safeParse({ fullName: "Blessing Kalu", patientRef: "a b" }).success).toBe(false);
  });
  it("accepts a patientRef of letters, digits and dashes", () => {
    expect(createPatientRecordSchema.safeParse({ fullName: "Blessing Kalu", patientRef: "WR-1187-22" }).success).toBe(true);
  });
});

describe("listPatientRecordsQuerySchema", () => {
  it("defaults the limit to 100", () => {
    expect(listPatientRecordsQuerySchema.parse({}).limit).toBe(100);
  });
});
