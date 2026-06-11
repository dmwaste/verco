/** Canonical FAQ item shape — matches `client.faq_items` JSONB and `faqItemSchema`.
 * Lives here (not in actions.ts) because 'use server' files reject type exports.
 * A `type` (not `interface`) so it casts cleanly from Supabase's `Json[]`. */
export type FaqItem = {
  question: string
  answer: string
}

export const DEFAULT_FAQS: FaqItem[] = [
  {
    question: 'What items can I put out for collection?',
    answer:
      'We collect general household bulk waste, green waste, mattresses, e-waste, and whitegoods. Hazardous materials, asbestos, tyres, and food waste are not accepted.',
  },
  {
    question: 'How many collections am I entitled to?',
    answer:
      "Your annual entitlement depends on your council's allocation rules. Check your address on the booking page to see your remaining allocation for this financial year.",
  },
  {
    question: 'When should I put my items out?',
    answer:
      'Items must be on the verge by 7am on your collection day. You will receive a reminder SMS and email the day before.',
  },
  {
    question: 'Can I cancel my booking?',
    answer:
      'Yes — bookings can be cancelled up until 3:30pm the day before your scheduled collection. Log in to your dashboard to cancel.',
  },
  {
    question: "What if my items weren't collected?",
    answer:
      "If your items weren't collected, contact us using the form below and we will follow up with the collection team.",
  },
]
