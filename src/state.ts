import { createMatchActions } from "./stateActions";

export {
  hydrate,
  resetStateForTest,
} from "./statePersistence";

export function useMatch() {
  return createMatchActions();
}
