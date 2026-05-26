export default async function globalTeardown(): Promise<void> {
  // Safety net: any per-suite cleanup that failed
  // Individual test files handle their own cleanup via TestDataManager
  // This is intentionally minimal - just a hook for future use
  console.log("✓ Test run complete");
}
