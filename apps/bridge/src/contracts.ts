/**
 * One import path for the shared contract.
 *
 * The contract lives in `packages/contracts` because the console and OpenMAIC
 * patches copy it verbatim; the bridge consumes it from source so the three
 * copies can be diffed against one another by eye.
 */
export * from "../../../packages/contracts/src/index.ts";
