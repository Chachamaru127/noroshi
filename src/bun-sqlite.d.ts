declare module 'bun:sqlite' {
	type SQLiteStatementResult = { changes?: number };
	type SQLiteStatement = {
		get<T = unknown>(...args: unknown[]): T | undefined;
		all<T = unknown>(...args: unknown[]): T[];
		run(...args: unknown[]): SQLiteStatementResult;
	};
	export class Database {
		constructor(filename: string);
		exec(sql: string): void;
		query(sql: string): SQLiteStatement;
	}
}
