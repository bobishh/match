<script setup lang="ts">
import { ref } from "vue"
import { hideLeavingElement, showEnteringElement, useModal } from "../ui/modal"

defineOptions({ inheritAttrs: false })
const props = defineProps<{ protectDraft?: boolean; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement | null>(null)
const edited = ref(false)
useModal(root, () => { if (!props.busy) emit("close") })

function closeFromBackdrop() {
  if (!props.busy && !(props.protectDraft && edited.value)) emit("close")
}
</script>

<template>
  <Transition name="modal" appear @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
    <div ref="root" class="overlay" role="presentation" v-bind="$attrs"
      @click.self="closeFromBackdrop" @input.capture="edited = true" @change.capture="edited = true">
      <slot />
    </div>
  </Transition>
</template>
