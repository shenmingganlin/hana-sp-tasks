// Hana injects invocation context after validating model arguments. Keep it out
// of business validation, request bodies and outputs without changing the SDK.
export function registerAppTool(sdk, definition) {
  return sdk.tools.register({
    ...definition,
    execute: (input) => {
      const args = input !== null && typeof input === "object" && !Array.isArray(input)
        ? Object.fromEntries(Object.keys(input).filter((key) => key !== "context").map((key) => [key, input[key]]))
        : input;
      return definition.execute(args);
    },
  });
}
