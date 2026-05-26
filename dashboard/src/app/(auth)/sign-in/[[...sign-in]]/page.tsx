import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F5EE]">
      <SignIn
        afterSignInUrl="/portfolio"
        appearance={{
          elements: {
            rootBox: "w-full max-w-md",
            card: "shadow-none bg-transparent",
            socialButtonsBlockButton:
              "bg-[#1A1A1A] text-white hover:bg-[#333] border-none h-12 text-base font-medium rounded-none",
            socialButtonsBlockButtonText: "font-semibold",
            dividerRow: "hidden",
            form: "hidden",
            footer: "hidden",
            header: "hidden",
            socialButtonsProviderIcon: "w-5 h-5",
          },
        }}
      />
    </div>
  );
}
