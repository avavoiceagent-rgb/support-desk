/**
 * A refusal a person can act on.
 *
 * The ops screens are used by dispatchers under time pressure, so "Invalid
 * input" is not good enough: the message here is written to be read out loud
 * and understood without opening the code. Routes turn these into responses;
 * nothing else catches them.
 */
export class OpsError extends Error {
  constructor(
    message: string,
    /** 400 for "you asked for something impossible", 404 for "no such thing". */
    readonly status: number = 400
  ) {
    super(message);
    this.name = "OpsError";
  }
}
