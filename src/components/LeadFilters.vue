<script setup lang="ts">
import { computed } from "vue"
import { defaultLeadFilters, type LeadFilters } from "../filters"
import { priorityLabels, statusLabels } from "../types"

const props = defineProps<{ modelValue: LeadFilters }>()
const emit = defineEmits<{ "update:modelValue": [value: LeadFilters] }>()

const filters = computed(() => ({ ...defaultLeadFilters, ...props.modelValue }))

function update<Key extends keyof LeadFilters>(key: Key, value: LeadFilters[Key]) {
  emit("update:modelValue", { ...filters.value, [key]: value })
}
</script>

<template>
  <fieldset class="lead-filters">
    <legend>Filters</legend>
    <label class="filter-label">
      <span>Status</span>
      <select :value="filters.status" @change="update('status', ($event.target as HTMLSelectElement).value as LeadFilters['status'])">
        <option value="all">All cards</option>
        <option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option>
      </select>
    </label>
    <label class="filter-label">
      <span>Priority</span>
      <select :value="filters.priority" @change="update('priority', ($event.target as HTMLSelectElement).value as LeadFilters['priority'])">
        <option value="all">Any priority</option>
        <option v-for="(label, priority) in priorityLabels" :key="priority" :value="priority">{{ label }}</option>
      </select>
    </label>
    <label class="filter-label">
      <span>Work mode</span>
      <select :value="filters.workMode" @change="update('workMode', ($event.target as HTMLSelectElement).value as LeadFilters['workMode'])">
        <option value="all">Any mode</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="unknown">Unknown</option>
      </select>
    </label>
    <label class="filter-label">
      <span>Fit</span>
      <select :value="filters.fit" @change="update('fit', ($event.target as HTMLSelectElement).value as LeadFilters['fit'])">
        <option value="all">Any fit</option><option value="strong">8–10</option><option value="possible">6–7</option><option value="low">0–5</option><option value="unscored">Unscored</option>
      </select>
    </label>
  </fieldset>
</template>
