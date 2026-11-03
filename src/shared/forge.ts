import type { ForgeKind } from './types';

/** Where to create a token on a forge, with the scopes Nest needs filled in where the forge allows. */
export function tokenPageUrl(kind: ForgeKind, host: string): string {
  if (kind === 'github') return `https://${host}/settings/tokens/new?scopes=repo,read:org&description=Nest`;
  if (kind === 'gitlab') return `https://${host}/-/user_settings/personal_access_tokens?name=Nest&scopes=api`;
  return `https://${host}/user/settings/applications`;
}

/** The permissions a token needs, in each forge's own words. */
export const TOKEN_SCOPES: Record<ForgeKind, string> = {
  github: 'Classic token: repo. Fine-grained: Contents and Metadata (read), Pull requests (read and write), Checks and Actions (read).',
  gitlab: 'Scope: api.',
  forgejo: 'Scopes: read:user, write:repository, write:issue.',
};

/** How to sign in with the forge's own CLI, which Nest then uses too. */
export const CLI_SIGN_IN: Record<ForgeKind, string> = { github: 'gh auth login', gitlab: 'glab auth login', forgejo: 'tea login add' };
