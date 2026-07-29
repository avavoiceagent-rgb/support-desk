import { Request } from "express";

/** Express types route params as `string | string[]`; routes here never use
 * repeated-param patterns, so this narrows to the plain string safely. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}
