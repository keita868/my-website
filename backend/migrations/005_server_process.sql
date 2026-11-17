CREATE TABLE server_process (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL CHECK (pid > 0),
  token TEXT NOT NULL
);
