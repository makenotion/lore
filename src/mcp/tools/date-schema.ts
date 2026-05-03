import { z } from "zod"

export const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/
export const YMD_DATE_MESSAGE = "Must be YYYY-MM-DD format"

export const ymdDateSchema = z.string().regex(YMD_REGEX, YMD_DATE_MESSAGE)

export const clearableYmdDateSchema = z
  .string()
  .transform((value, ctx) => {
    if (value === "") return null
    if (YMD_REGEX.test(value)) return value

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: YMD_DATE_MESSAGE,
    })
    return z.NEVER
  })
  .nullable()
