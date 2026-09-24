import { createMatchActions } from "./stateActions";

export {
  hydrate,
  reconcile,
  resetStateForTest,
} from "./statePersistence";

export function useMatch() {
  return createMatchActions();
}
