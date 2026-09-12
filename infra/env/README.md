# Production environment files

The server reads one `.env` at the repository root (`infra/compose.yml`, `env_file`). This folder
holds an **encrypted** copy of it, so the real values are versioned, reviewable and deployable from
CI without being committed in clear text.

## Default: SOPS + age (no account needed)

1. Install [`sops`](https://github.com/getsops/sops/releases) and [`age`](https://github.com/FiloSottile/age)
   (`brew install sops age`, `scoop install sops age`, or the release binaries).
2. Create a key once:
   ```sh
   age-keygen -o ~/.config/sops/age/keys.txt
   ```
   Put the printed public key (`age1…`) in `/.sops.yaml`. Back the key file up. It is the only way
   to read the encrypted env.
3. Encrypt your filled-in production env:
   ```sh
   sops --encrypt --input-type dotenv --output-type dotenv .env > infra/env/production.enc.env
   git add infra/env/production.enc.env
   ```
   Names stay in clear text, values are ciphertext. Edit later with
   `sops infra/env/production.enc.env`.
4. CI: add the *private* key (the `AGE-SECRET-KEY-…` line) as the `SOPS_AGE_KEY` repository secret.
   `deploy.yml` then decrypts the file and writes it to the server as `.env` before every deploy.
5. By hand on the server:
   ```sh
   sops --decrypt --input-type dotenv --output-type dotenv infra/env/production.enc.env > .env
   ```

To rotate a secret: change it in the encrypted file (`sops …`), commit, push. The next deploy ships
it and restarts the containers that read it.

To rotate the age key: add the new recipient to `.sops.yaml`, run
`sops updatekeys infra/env/production.enc.env`, remove the old one, update `SOPS_AGE_KEY`.

## Alternatives

- **1Password**: keep the env as a Secure Note, or use references (`op://vault/item/field`) in a
  template and render it on the server with `op inject -i .env.tpl -o .env` (Service Account token
  in `OP_SERVICE_ACCOUNT_TOKEN`).
- **Doppler**: `doppler secrets download --no-file --format env > .env` on the server or in CI
  (`DOPPLER_TOKEN`).
- **Plain `.env` on the server** (what `infra/scripts/provision.sh` writes): fine for one box you
  administer yourself. `chmod 600`, keep it out of git (it already is), and back it up with the
  database. A restore without it is not a restore.

Whatever you pick, the containers only ever see environment variables. Nothing in the apps changes.
