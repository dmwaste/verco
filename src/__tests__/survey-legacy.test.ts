import { describe, it, expect } from 'vitest'
import { legacySurveyRef, surveyDisplayRef } from '@/lib/survey/legacy'

describe('legacy survey ref (ADR 0016)', () => {
  it('shows the Airtable ref half of external_ref', () => {
    expect(legacySurveyRef('VIN-B-58104|8/22/2026 8:33pm')).toBe('VIN-B-58104')
    expect(legacySurveyRef('|8/22/2026 8:33pm')).toBeNull()
    expect(legacySurveyRef(null)).toBeNull()
  })
  it('prefers the Verco booking ref when linked', () => {
    expect(surveyDisplayRef('VIN-B-58104', 'VIN-B-58104|x')).toBe('VIN-B-58104')
    expect(surveyDisplayRef(undefined, 'MOS-55066|x')).toBe('MOS-55066')
    expect(surveyDisplayRef(null, null)).toBeNull()
  })
})
