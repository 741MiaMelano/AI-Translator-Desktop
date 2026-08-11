import { useModelApiController } from "./model-api-controller";
import { ModelApiView } from "./model-api-view";

export default function ModelApiPage() {
  return <ModelApiView controller={useModelApiController()} />;
}
