import { useStartTranslateController } from "./start-translate-controller";
import { StartTranslateView } from "./start-translate-view";

export default function StartTranslatePage() {
  return <StartTranslateView controller={useStartTranslateController()} />;
}
