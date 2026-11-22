import { backup, DatabaseSync } from 'node:sqlite';

export class SQLiteDataAccess {
  #connection;

  constructor(path, options = {}) {
    this.#connection = new DatabaseSync(path, options);
  }

  prepare(statement) {
    return this.#connection.prepare(statement);
  }

  exec(statement) {
    return this.#connection.exec(statement);
  }

  function(name, options, implementation) {
    return this.#connection.function(name, options, implementation);
  }

  backup(destination) {
    return backup(this.#connection, destination);
  }

  close() {
    return this.#connection.close();
  }
}

export function openSQLiteDatabase(path, options = {}) {
  return new SQLiteDataAccess(path, options);
}