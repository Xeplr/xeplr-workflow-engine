// WHICH ENV VARS A WORKFLOW STEP MAY REFERENCE, as `{env.NAME}`.
//
// Nothing, unless named:
//
//   WORKFLOW_ENV_EXPOSED=PUBLIC_BASE_URL,DEPLOY_TAG
//
// AN ALLOWLIST, NOT A DENYLIST, and that is the whole design. A denylist works
// on the day it is written and fails silently afterwards: the day somebody
// adds STRIPE_SECRET_KEY to the environment it is readable until a second
// person remembers to go and hide it. This way a new variable is invisible
// until it is deliberately published, so the failure mode of forgetting is
// "the template renders empty" rather than "the key leaked".
//
// WHY THIS MATTERS MORE THAN IT LOOKS. A resolved step input is not private:
//
//   - POST /workflows/:id/steps/try ECHOES the interpolated input straight
//     back to the browser, by design, so the builder can show what it sent
//     (see lib/router.js). The step does not even have to be saved — `values`
//     comes off the request body.
//   - workflowRunner writes the resolved values into WorkflowStepRun.input,
//     where they stay for the life of the run history.
//
// So without a list, "can author a workflow step" would silently mean "can
// read ENCRYPTION_KEY and AUTH_JWT_SECRET" — the two that decrypt every
// stored connection string and mint a token for any user. Both halves of that
// escalation look ordinary in an access-control table, which is exactly why
// it has to be shut off here rather than noticed later.
//
// KEEP SECRETS OFF THIS LIST. It is for values that are awkward to hardcode
// per environment and harmless to read: a public base URL, an environment
// tag, a bucket name. A credential belongs on the path where the ACTION reads
// it server-side at execution time and it never enters the template context
// at all — that is what `useCustomConnection: false` on the email actions
// does with SMTP_*, and it is strictly safer than any list.

// Exact names only. No prefixes and no globs: `PUBLIC_*` reads as a small
// convenience right up until somebody names a secret PUBLIC_something, and
// then the list no longer says what it exposes. A literal '*' matches a
// variable actually called '*', which does not exist — so the tempting
// shortcut fails closed rather than exposing everything.
function exposedNames() {
  var raw = process.env.WORKFLOW_ENV_EXPOSED;
  if (!raw) return [];
  return String(raw).split(',')
    .map(function(n) { return n.trim(); })
    .filter(function(n) { return n.length > 0; });
}

/**
 * The `env` branch of a step's interpolation context.
 *
 * Read per call rather than memoized at load: this module is required before
 * the host has finished loading its .env in at least one boot order, and a
 * snapshot taken then would be permanently empty with nothing to explain it.
 * The cost is splitting a short string once per step.
 *
 * A name on the list that is not set is OMITTED rather than included as
 * undefined — either way `{env.NAME}` renders as empty string, since that is
 * what interpolate() does with any unknown path (see @xeplr/schema-handler's
 * templating.js). Worth knowing when debugging: a misspelled name and an
 * unexposed one look identical in the output.
 */
function exposedEnv() {
  var out = {};
  exposedNames().forEach(function(name) {
    if (process.env[name] !== undefined) out[name] = process.env[name];
  });
  return out;
}

/**
 * Say at boot what is readable, so it is a fact in the log rather than a
 * thing you would have to go and derive from an .env file. A list that
 * accidentally names a secret is only catchable if somebody can see it.
 */
function logExposure() {
  var names = exposedNames();
  if (!names.length) return;
  var missing = names.filter(function(n) { return process.env[n] === undefined; });
  console.log('[workflow] {env.*} exposes ' + names.length + ' var(s) to step templates: ' + names.join(', '));
  if (missing.length) {
    console.warn('[workflow] WORKFLOW_ENV_EXPOSED names ' + missing.length +
      ' var(s) that are not set (they resolve to empty string): ' + missing.join(', '));
  }
}

module.exports = { exposedNames: exposedNames, exposedEnv: exposedEnv, logExposure: logExposure };
