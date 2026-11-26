import { isCodespaceName } from "../../phone/runner/contracts.mjs";

export { isCodespaceName };

/** Throws `error` (an Error by default) when `name` is not a codespace name. */
export function assertCodespaceName(name: unknown, error: () => Error = () => new Error("Invalid codespace name")): asserts name is string {
  if (!isCodespaceName(name)) throw error();
}

/** A GitHub machine type name. The same character rule as a codespace name, kept apart in case GitHub changes one. */
export const isMachineName = (name: unknown): name is string => typeof name === "string" && /^[\w-]{1,100}$/.test(name);
