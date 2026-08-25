import { type } from "@oh-my-pi/omptype";
import { DEFAULT_HUB_LIST_LIMIT, MAX_HUB_LIST_LIMIT } from "./types";

export const hubSchema = type({
	op: type(
		"'send' | 'wait' | 'inbox' | 'list' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
	).describe("hub operation"),
	"to?": type("string").describe('send: recipient agent id or "all"'),
	"message?": type("string").describe("send: message body"),
	"replyTo?": type("string").describe("send: message id being answered"),
	"await?": type("boolean").describe('send: wait for the recipient\'s reply (invalid with to:"all")'),
	"from?": type("string").describe("wait: only accept a message from this agent id"),
	"ids?": type("string[]").describe("wait: job ids to watch (omit = all running jobs); cancel: job ids to kill"),
	"timeoutMs?": type("number").describe("wait (messages/jobs): timeout in milliseconds (0 waits indefinitely)"),
	"peek?": type("boolean").describe("inbox: list messages without consuming them"),
	"status?": type("'running' | 'idle' | 'parked'").describe("list: filter by status; omit for running+idle"),
	"limit?": type("number > 0").describe(
		`list: max peer rows; default ${DEFAULT_HUB_LIST_LIMIT}, max ${MAX_HUB_LIST_LIMIT}`,
	),
	"name?": type("string <= 48").describe("process ops: stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last omp client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every omp and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait with name: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait with name: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send with name: stdin text"),
	"enter?": type("boolean").describe("send with name: append Enter after text; default true"),
	"keys?": type("string[]").describe("send with name: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe(
		"send with name: process-tree signal",
	),
	"timeout?": type("number > 0").describe("logs/stop/wait with name: max seconds; default 30 (stop: 5)"),
});
