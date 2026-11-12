Runtime engine files are build outputs (derived from node_modules by
scripts/install-runtime.mjs). They are regenerated per checkout and served by
the play worker; never commit them.
