import { getToken, setToken, clearToken } from './api';

export { getToken, setToken, clearToken };

/** Returns true if a token is stored. Does not validate against server. */
export function isAuthenticated(): boolean {
  return getToken().length > 0;
}
