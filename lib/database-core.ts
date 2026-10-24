export type DatabaseRow = Record<string, unknown>;
export type QueryResult = { rows: DatabaseRow[]; count: number };
export type QueryExecutor = (sql: string, parameters: unknown[]) => Promise<QueryResult>;

/** Convert application placeholders without touching SQL strings or comments. */
export function postgresPlaceholders(input: string): string {
  let result = '', index = 0, cursor = 0;
  while (cursor < input.length) {
    const c = input[cursor];
    if (c === "'" || c === '"') {
      const quote = c; result += c; cursor++;
      while (cursor < input.length) {
        const ch = input[cursor++]; result += ch;
        if (ch === quote) { if (input[cursor] === quote) {result += input[cursor++];} else break; }
      }
    } else if (input.startsWith('--', cursor)) {
      const end = input.indexOf('\n', cursor); const stop = end < 0 ? input.length : end;
      result += input.slice(cursor, stop); cursor = stop;
    } else if (input.startsWith('/*', cursor)) {
      let depth = 1; result += '/*'; cursor += 2;
      while (cursor < input.length && depth) {
        if (input.startsWith('/*',cursor)) {depth++;result+='/*';cursor+=2;}
        else if(input.startsWith('*/',cursor)){depth--;result+='*/';cursor+=2;}
        else result += input[cursor++];
      }
    } else if (c === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(input.slice(cursor))) {
      const delimiter = input.slice(cursor).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
      const end = input.indexOf(delimiter, cursor + delimiter.length);
      const stop = end < 0 ? input.length : end + delimiter.length;
      result += input.slice(cursor, stop); cursor = stop;
    } else {result += c === '?' ? '$' + (++index) : c; cursor++;}
  }
  return result;
}

export function normalizeDatabaseValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') { const n=Number(value); if(!Number.isSafeInteger(n)) throw new Error('Database count exceeds the safe integer range.'); return n; }
  if (Array.isArray(value)) return value.map(normalizeDatabaseValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalizeDatabaseValue(v)]));
  return value;
}

export class Statement {
  readonly sql:string; readonly parameters:unknown[]; readonly execute:QueryExecutor;
  constructor(sql:string,parameters:unknown[],execute:QueryExecutor){this.sql=sql;this.parameters=parameters;this.execute=execute;}
  bind(...parameters: unknown[]) { return new Statement(this.sql,parameters,this.execute); }
  async result() { return this.execute(postgresPlaceholders(this.sql),this.parameters); }
  async first<T = DatabaseRow>(): Promise<T|null> { const result=await this.result(); return (result.rows[0] as T|undefined)??null; }
  async all<T = DatabaseRow>(): Promise<{results:T[];meta:{changes:number}}> { const result=await this.result(); return {results:result.rows as T[],meta:{changes:result.count}}; }
  async run(): Promise<{meta:{changes:number}}> { const result=await this.result(); return {meta:{changes:result.count}}; }
}

export type TransactionRunner = <T>(callback:(database:Database)=>Promise<T>)=>Promise<T>;
export class Database {
  readonly execute:QueryExecutor;readonly begin?:TransactionRunner;
  constructor(execute:QueryExecutor,begin?:TransactionRunner){this.execute=execute;this.begin=begin;}
  prepare(sql:string){return new Statement(sql,[],this.execute);}
  async transaction<T>(callback:(database:Database)=>Promise<T>):Promise<T>{
    if(this.begin)return this.begin(callback);
    // Inside a transaction, use the same transaction connection.
    return callback(this);
  }
  async batch(statements:Statement[]){return this.transaction(async tx=>{const results=[];for(const statement of statements)results.push(await tx.prepare(statement.sql).bind(...statement.parameters).run());return results;});}
}
