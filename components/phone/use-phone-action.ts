"use client";

import { useActionState, useCallback } from "react";
import { mutatePhone } from "@/app/actions/phones";
import { useToast } from "@/components/ui/ui-provider";

/** Notify on submission completion, never when a cached page's effects restart. */
export function usePhoneAction() {
  const notify = useToast();
  const submit = useCallback(async (previous: Awaited<ReturnType<typeof mutatePhone>>, form: FormData) => {
    const result = await mutatePhone(previous, form);
    if (result.message) notify(result.message);
    return result;
  }, [notify]);
  return useActionState(submit, { message: "" });
}
