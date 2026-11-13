// Child process for the concurrent-mint test. Prints the token it was handed.
const [, , handle, repoRoot] = process.argv;
const mod = await import(`${repoRoot}/src/supervise/handle-tokens.ts`);
process.stdout.write(mod.mintToken(handle as string));
