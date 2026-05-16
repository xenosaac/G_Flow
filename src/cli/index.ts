const HELP = `gflow — orchestration system for coding agents

Usage:
  gflow start "<goal>"   Begin a new flow from a user goal
  gflow status           Show status of the latest flow
  gflow resume           Resume the latest non-complete flow
  gflow help             Show this help

Environment:
  GFLOW_TARGET_DIR       Worker sandbox dir (default: ../demo-target)
`;

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  switch (cmd) {
    case "start":
    case "status":
    case "resume":
      console.error(`gflow: command "${cmd}" is not yet implemented (M1 bootstrap)`);
      return 2;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      console.error(`gflow: unknown command "${cmd}"`);
      process.stdout.write(HELP);
      return 64;
  }
}
