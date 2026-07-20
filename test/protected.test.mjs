import { test } from "node:test";
import assert from "node:assert/strict";
import {
  protectedRecruiterForPoster,
  protectedRecruiterForRoleTitle,
  protectedRecruiterForLinkedinJobId,
  protectedRecruiterForRole,
  protectedRecruiterForSequence,
  isProtectedRole,
} from "../api/seq/_lib/protected.mjs";

test("poster match: Kyra aliases (case/space tolerant), not others", () => {
  assert.ok(protectedRecruiterForPoster("Kyra Phillips (Wyman)"));
  assert.ok(protectedRecruiterForPoster("  kyra   phillips (wyman) "));
  assert.ok(protectedRecruiterForPoster("Kyra Wyman"));
  assert.ok(protectedRecruiterForPoster("Kyra Phillips"));
  assert.equal(protectedRecruiterForPoster("David Phillips"), null);
  assert.equal(protectedRecruiterForPoster("Noah Kingsdale"), null);
  assert.equal(protectedRecruiterForPoster(""), null);
  assert.equal(protectedRecruiterForPoster(null), null);
});

test("role-title match: Corporate/Commercial Counsel, embedded + case-insensitive", () => {
  assert.ok(protectedRecruiterForRoleTitle("Corporate Counsel"));
  assert.ok(protectedRecruiterForRoleTitle("corporate counsel (remote - us)"));
  assert.ok(protectedRecruiterForRoleTitle("Commercial Counsel (2nd Legal Hire) - HealthTech"));
  assert.equal(protectedRecruiterForRoleTitle("Product Manager"), null);
  assert.equal(protectedRecruiterForRoleTitle("General Counsel"), null); // not a listed pattern
  assert.equal(protectedRecruiterForRoleTitle(""), null);
});

test("LinkedIn job id match", () => {
  assert.ok(protectedRecruiterForLinkedinJobId("4436912132"));
  assert.ok(protectedRecruiterForLinkedinJobId("4400419853"));
  assert.equal(protectedRecruiterForLinkedinJobId("4439784327"), null); // David's VP role
  assert.equal(protectedRecruiterForLinkedinJobId(""), null);
});

test("combined protectedRecruiterForRole: any positive signal protects", () => {
  assert.ok(isProtectedRole({ roleTitle: "Corporate Counsel" }));
  assert.ok(isProtectedRole({ poster: "Kyra Phillips (Wyman)" }));
  assert.ok(isProtectedRole({ linkedinJobId: "4436912132" }));
  assert.ok(isProtectedRole({ roleTitle: "Product Manager", poster: "Kyra Wyman" })); // poster wins
  assert.equal(isProtectedRole({ roleTitle: "Product Manager", poster: "David Phillips" }), false);
  assert.equal(protectedRecruiterForRole({}), null);
  assert.equal(isProtectedRole({}), false);
});

test("sequence match: the launcher-named Kyra sequence, not David's", () => {
  assert.ok(protectedRecruiterForSequence({ name: "No Scheduled Call - Raydar - 1st Round Interview - Corporate Counsel", enabled: true }));
  assert.ok(protectedRecruiterForSequence({ name: "Anything", role_name: "Corporate Counsel" }));
  assert.equal(protectedRecruiterForSequence({ name: "No Scheduled Call - Raydar - 1st Round Interview - Product Manager" }), null);
  assert.equal(protectedRecruiterForSequence({ name: "No Scheduled Call - Raydar - 1st Round Interview - Staff Software Engineer" }), null);
});
