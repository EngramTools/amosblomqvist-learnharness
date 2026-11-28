const INPUT_CLASS = "lh-language-coach-settings__input";

export function note(document: Document, text: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.className = "lh-language-coach-settings__note";
  paragraph.textContent = text;
  return paragraph;
}

function labeled<T extends HTMLInputElement | HTMLSelectElement>(document: Document, label: string, input: T) {
  const field = document.createElement("label");
  field.className = "lh-language-coach-settings__field";
  const title = document.createElement("span");
  title.textContent = label;
  input.className = INPUT_CLASS;
  field.append(title, input);
  return { field, input };
}

export function passwordField(document: Document, label: string, id: string) {
  const input = document.createElement("input");
  input.type = "password";
  input.id = id;
  input.autocomplete = "off";
  input.spellcheck = false;
  return labeled(document, label, input);
}

export function textField(document: Document, label: string, id: string, placeholder: string) {
  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  input.placeholder = placeholder;
  return labeled(document, label, input);
}

export function selectField(document: Document, label: string, id: string, options: { value: string; label: string }[]) {
  const input = document.createElement("select");
  input.id = id;
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    input.append(element);
  }
  return labeled(document, label, input);
}

export function button(document: Document, type: "submit" | "button", text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = type;
  element.textContent = text;
  return element;
}
