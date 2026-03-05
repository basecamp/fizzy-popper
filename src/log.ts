import chalk from "chalk"

const ICONS = {
  board: "◆",
  agent: "●",
  success: "✓",
  error: "✗",
  warn: "▲",
  info: "◇",
  arrow: "↳",
} as const

function timestamp(): string {
  return chalk.dim(new Date().toLocaleTimeString())
}

export function header(text: string): void {
  console.log()
  console.log(`${ICONS.board} ${chalk.bold(text)}`)
}

export function board(name: string, detail: string): void {
  console.log()
  console.log(`  ${chalk.bold(name)}`)
  if (detail) console.log(`    ${chalk.dim(detail)}`)
}

export function column(name: string, backend: string): void {
  console.log(`    ${name} ${chalk.dim(`(golden ticket: #${backend})`)}`)
}

export function agentSpawn(cardNumber: number, title: string, columnName: string): void {
  console.log()
  console.log(`${ICONS.agent} ${chalk.cyan(`#${cardNumber}`)} ${chalk.bold(`"${title}"`)} → Agent: ${columnName}`)
}

export function agentStep(message: string): void {
  console.log(`  ${ICONS.arrow} ${message}`)
}

export function agentSuccess(durationSec: number, action: string): void {
  console.log(`  ${ICONS.arrow} ${chalk.green(`Completed`)} (${durationSec.toFixed(1)}s) — ${action}`)
}

export function agentError(error: string): void {
  console.log(`  ${ICONS.arrow} ${chalk.red(`Failed`)} — ${error}`)
}

export function info(message: string): void {
  console.log(`${ICONS.info} ${message}`)
}

export function warn(message: string): void {
  console.error(`${chalk.yellow(ICONS.warn)} ${chalk.yellow(message)}`)
}

export function error(message: string): void {
  console.error(`${chalk.red(ICONS.error)} ${chalk.red(message)}`)
}

export function event(action: string, detail: string): void {
  console.log(`${timestamp()} ${chalk.dim(action)} ${detail}`)
}

export function dim(message: string): void {
  console.log(chalk.dim(`  ${message}`))
}
