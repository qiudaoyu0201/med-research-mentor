import { z } from "zod";
import { read, save, missingRecord } from "./storage.ts";
import { learningPreferencesSchema } from "./schemas.ts";

export const tutorSettingsSchema = z
  .object({
    learningPreferences: learningPreferencesSchema.default({
      verbosity: "standard",
      focus: "balanced",
    }),
    webLookup: z.boolean().default(true),
    rememberTerms: z.boolean().default(true),
  })
  .strict();
export class TutorSettings {
  private value = tutorSettingsSchema.parse({});
  get() {
    return structuredClone(this.value);
  }
  async restore() {
    try {
      this.value = tutorSettingsSchema.parse(
        await read("tutor-settings", "default"),
      );
    } catch (error) {
      if (!missingRecord(error)) throw error;
    }
  }
  async update(input: unknown) {
    const next = tutorSettingsSchema.parse(input);
    await save("tutor-settings", "default", next);
    this.value = next;
    return this.get();
  }
}
