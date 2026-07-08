import type { DroidModelDescriptor } from "@kone/bridge-protocol";
import { ref } from "vue";

const droidModels = ref<DroidModelDescriptor[]>([]);
const droidModelsLoaded = ref(false);

export function getDroidModel(id: string) {
  return droidModels.value.find((model) => model.id === id);
}

export function useDroidModelStore() {
  const setDroidModels = (models: DroidModelDescriptor[]) => {
    droidModels.value = models;
    droidModelsLoaded.value = models.length > 0;
  };

  return {
    droidModels,
    droidModelsLoaded,
    setDroidModels,
    getDroidModel,
  };
}
