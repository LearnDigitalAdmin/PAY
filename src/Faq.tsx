import { useState } from 'react';
import { ChevronDown, ChevronUp, ArrowLeft, MessageCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

const faqs = [
  {
    question: 'What is Plot Yangu?',
    answer:
      'Plot Yangu is a modern property management platform designed for landlords, agents, and caretakers. It automates rent invoicing, WhatsApp reminders, payments, and reporting — all in one simple dashboard.',
  },
  {
    question: 'How do payments work on Plot Yangu?',
    answer:
      'All payments are securely processed via Paystack. When a tenant pays through Plot Yangu, Paystack automatically processes the payment, and the landlord or agent receives their share directly after settlement.',
  },
  {
    question: 'When will landlords receive their money?',
    answer:
      'Paystack settles funds on a standard T+2 basis (two business days after the transaction). This ensures compliance and allows time for banks to clear the payment.',
  },
  {
    question: 'Are there any hidden charges?',
    answer:
      'No hidden fees. Paystack charges a small transaction fee (1.5% for local, 2.9% for international transactions), and Plot Yangu adds a 1.5% platform fee. Both are transparent and clearly shown before payment.',
  },
  {
    question: 'Do landlords or agents need a Paystack account?',
    answer:
      'No, they don\'t. Plot Yangu Payments lets you automatically set up account by providing MPESA, Airtel Money, or Bank Details in the account settings, and payments are sent directly to their preferred bank or M-Pesa number.',
  },
  {
    question: 'Can tenants pay using M-Pesa or Airtel Money?',
    answer:
      'Yes! Tenants can pay using M-Pesa, Airtel Money, or even card payments. The process is smooth and designed for mobile-first use — especially on Android phones.',
  },
  {
    question: 'What if my internet is slow?',
    answer:
      'No worries — Plot Yangu Payments is built as a Progressive Web App (PWA), meaning it runs smoothly even on slow networks and can be installed directly on your Android phone or PC.',
  },
  {
    question: 'Is my data safe?',
    answer:
      'Absolutely. All data is encrypted and stored securely. Payments are handled by Paystack, a PCI-DSS certified payment processor trusted across Africa.',
  },
  {
    question: 'How do I get started as a landlord or agent?',
    answer:
      'Simply create an account, add your properties and tenants, and set up your payment details. Our platform will guide you through each step. You can also request a demo to see how everything works.',
  },
  {
    question: 'Can I send automated rent reminders?',
    answer:
      'Yes! Plot Yangu automatically sends WhatsApp reminders to tenants before rent is due, reducing late payments and manual follow-ups.',
  },
];

export default function FAQPage() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center space-x-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            <span className="font-medium">Back</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-4 py-8 sm:py-12">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-800 mb-3">
              Frequently Asked Questions
            </h1>
            <p className="text-gray-600">
              Everything you need to know about Plot Yangu
            </p>
          </div>

          <div className="space-y-3 sm:space-y-4">
            {faqs.map((faq, index) => (
              <div
                key={index}
                className="bg-white rounded-xl sm:rounded-2xl shadow-md overflow-hidden border border-gray-100 hover:shadow-lg transition duration-300"
              >
                <button
                  onClick={() => setOpenIndex(openIndex === index ? null : index)}
                  className="w-full flex justify-between items-start p-4 sm:p-6 text-left focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-inset"
                >
                  <span className="text-base sm:text-lg font-semibold text-gray-700 pr-4">
                    {faq.question}
                  </span>
                  <span className="flex-shrink-0">
                    {openIndex === index ? (
                      <ChevronUp className="w-5 h-5 text-indigo-600" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-gray-500" />
                    )}
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {openIndex === index && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.3 }}
                      className="px-4 sm:px-6 pb-4 sm:pb-6 text-sm sm:text-base text-gray-600 leading-relaxed"
                    >
                      {faq.answer}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>

          {/* Contact Section */}
          <div className="mt-12 bg-white rounded-2xl shadow-lg p-6 sm:p-8 text-center">
            <MessageCircle className="w-12 h-12 text-indigo-600 mx-auto mb-4" />
            <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2">
              Still have questions?
            </h2>
            <p className="text-gray-600 mb-6">
              We're here to help! Reach out to our support team.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => navigate('/contact')}
                className="inline-flex items-center justify-center bg-indigo-600 text-white font-semibold px-6 py-3 rounded-lg hover:bg-indigo-700 transition duration-300"
              >
                Contact Us
              </button>
              <a
                href="https://cogvana.co.ke/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center bg-gray-100 text-gray-700 font-semibold px-6 py-3 rounded-lg hover:bg-gray-200 transition duration-300"
              >
                Other Services
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}