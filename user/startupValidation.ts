/**
 * Startup validation for security-critical environment variables.
 * Call once when the user service initialises.
 */
export function validateAuthEnvironment(): void {
  const rpOrigin = process.env.RP_ORIGIN ?? "";
  const rpName = process.env.RP_NAME ?? "";

  if (!rpOrigin) {
    throw new Error("FATAL: RP_ORIGIN environment variable is required.");
  }

  if (!rpName) {
    throw new Error("FATAL: RP_NAME environment variable is required.");
  }

  // WebAuthn requires HTTPS in production (browsers enforce this too).
  if (
    process.env.NODE_ENV === "production" &&
    !rpOrigin.startsWith("https://")
  ) {
    throw new Error(
      `FATAL: RP_ORIGIN must use HTTPS in production. Got: ${rpOrigin}`
    );
  }

  // Warn in development when using plain HTTP
  if (rpOrigin.startsWith("http://") && process.env.NODE_ENV !== "test") {
    console.warn(
      "[security] WARNING: RP_ORIGIN uses plain HTTP – acceptable only for local development."
    );
  }
}
