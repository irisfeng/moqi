export interface PresentableModel {
  value: string;
  label: string;
  buttonLabel: string;
  harnessId: string;
  model: { id: string; provider: string };
}

const flashIds = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

export function modelPresentation(id: string, label: string, now = Date.now(), provider = "") {
  if (provider === "deepseek" && flashIds.has(id))
    return {
      label: "DeepSeek V4.1 Flash",
      description: id === "deepseek-v4-flash" ? "Text tasks · legacy entry" : "Text and images · general tasks",
      badge: now >= Date.UTC(2026, 8, 10) && now < Date.UTC(2026, 9, 10) ? "New" : "",
    };
  if (provider === "deepseek" && id === "deepseek-v4-pro")
    return { label, description: "Deep reasoning · text only", badge: "" };
  if (provider === "zhipu-glm" && id === "glm-5.3-flash")
    return { label, description: "Image and text · office and coding", badge: "" };
  if (provider === "zhipu-glm" && id === "glm-5.3") return { label, description: "Complex text and code", badge: "" };
  return { label, description: "", badge: "" };
}

export function modelMenuOptions<T extends PresentableModel>(options: readonly T[], selected: string) {
  return options
    .filter((option) => {
      if (option.model.provider !== "deepseek" || !flashIds.has(option.model.id)) return true;
      const siblings = options.filter(
        (other) =>
          flashIds.has(other.model.id) &&
          other.harnessId === option.harnessId &&
          other.model.provider === option.model.provider,
      );
      const canonical =
        siblings.find((other) => other.model.id === "deepseek-flash") ??
        siblings.find((other) => other.model.id === "deepseek-v4-flash-vision-exp");
      if (!canonical) return true;
      return option === canonical || option.value === selected;
    })
    .map((option) => ({
      ...option,
      ...modelPresentation(option.model.id, option.label, Date.now(), option.model.provider),
    }));
}
