import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge only knows Tailwind's stock font-size scale, so it classifies
// the custom @theme sizes (globals.css) as text COLOURS and silently drops them
// when a real colour appears in the same cn() call (e.g. 'text-caption' +
// 'text-gray-500' → text-caption removed). Register them as font-size utilities
// so size + colour coexist. Keep in sync with the --text-* tokens in globals.css.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["2xs", "caption", "body-sm", "body", "subtitle", "title", "display"] },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
