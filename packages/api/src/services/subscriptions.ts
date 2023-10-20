import axios from 'axios'
import { DeepPartial, DeleteResult } from 'typeorm'
import { appDataSource } from '../data_source'
import { NewsletterEmail } from '../entity/newsletter_email'
import { Subscription } from '../entity/subscription'
import { SubscriptionStatus, SubscriptionType } from '../generated/graphql'
import { authTrx, getRepository } from '../repository'
import { logger } from '../utils/logger'
import { sendEmail } from '../utils/sendEmail'

interface SaveSubscriptionInput {
  userId: string
  name: string
  newsletterEmailId: string
  unsubscribeMailTo?: string
  unsubscribeHttpUrl?: string
  icon?: string
  from?: string
}

export const UNSUBSCRIBE_EMAIL_TEXT =
  'This message was automatically generated by Omnivore.'

export const parseUnsubscribeMailTo = (unsubscribeMailTo: string) => {
  const parsed = new URL(`mailto://${unsubscribeMailTo}`)
  const subject = parsed.searchParams.get('subject') || 'Unsubscribe'
  const to = unsubscribeMailTo.replace(parsed.search, '')

  // validate email address
  if (!to || !to.includes('@')) {
    throw new Error(`Invalid unsubscribe email address: ${unsubscribeMailTo}`)
  }

  return {
    to,
    subject,
  }
}

const sendUnsubscribeEmail = async (
  unsubscribeMailTo: string,
  newsletterEmail: string
): Promise<boolean> => {
  try {
    // get subject from unsubscribe email address if exists
    const parsed = parseUnsubscribeMailTo(unsubscribeMailTo)

    const sent = await sendEmail({
      to: parsed.to,
      subject: parsed.subject,
      text: UNSUBSCRIBE_EMAIL_TEXT,
      from: newsletterEmail,
    })

    if (!sent) {
      logger.info(`Failed to send unsubscribe email: ${unsubscribeMailTo}`)
      return false
    }

    return true
  } catch (error) {
    logger.info('Failed to send unsubscribe email', error)
    return false
  }
}

const sendUnsubscribeHttpRequest = async (url: string): Promise<boolean> => {
  try {
    await axios.get(url, {
      timeout: 5000, // 5 seconds
    })

    return true
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.info(`Failed to send unsubscribe http request: ${error.message}`)
    } else {
      logger.info('Failed to send unsubscribe http request', error)
    }
    return false
  }
}

export const getSubscriptionByName = async (
  name: string,
  userId: string
): Promise<Subscription | null> => {
  return getRepository(Subscription).findOne({
    where: { name, type: SubscriptionType.Newsletter, user: { id: userId } },
    relations: ['newsletterEmail', 'user'],
  })
}

export const saveSubscription = async ({
  userId,
  name,
  newsletterEmailId,
  unsubscribeMailTo,
  unsubscribeHttpUrl,
  icon,
}: SaveSubscriptionInput): Promise<string> => {
  const subscriptionData = {
    unsubscribeHttpUrl,
    unsubscribeMailTo,
    icon,
    lastFetchedAt: new Date(),
  }

  const existingSubscription = await getSubscriptionByName(name, userId)
  const result = await appDataSource.transaction(async (tx) => {
    if (existingSubscription) {
      // update subscription if already exists
      await tx
        .getRepository(Subscription)
        .update(
          { id: existingSubscription.id, user: { id: userId } },
          subscriptionData
        )

      return existingSubscription
    }

    return tx.getRepository(Subscription).save({
      ...subscriptionData,
      name,
      newsletterEmail: { id: newsletterEmailId },
      user: { id: userId },
      type: SubscriptionType.Newsletter,
    })
  })

  return result.id
}

export const unsubscribe = async (subscription: Subscription) => {
  // unsubscribe from newsletter
  if (subscription.type === SubscriptionType.Newsletter) {
    if (subscription.unsubscribeMailTo && subscription.newsletterEmail) {
      // unsubscribe by sending email
      const sent = await sendUnsubscribeEmail(
        subscription.unsubscribeMailTo,
        subscription.newsletterEmail.address
      )

      logger.info('Unsubscribe email sent', {
        subscriptionId: subscription.id,
        sent,
      })
    }
    // TODO: find a good way to unsubscribe by url if email fails or not provided
    // because it often requires clicking a button on the page to unsubscribe
  }

  return authTrx((tx) =>
    tx.getRepository(Subscription).update(subscription.id, {
      status: SubscriptionStatus.Unsubscribed,
    })
  )
}

export const unsubscribeAll = async (
  newsletterEmail: NewsletterEmail
): Promise<void> => {
  try {
    const subscriptions = await authTrx((t) =>
      t.getRepository(Subscription).find({
        where: {
          user: { id: newsletterEmail.user.id },
          newsletterEmail: { id: newsletterEmail.id },
        },
        relations: ['newsletterEmail'],
      })
    )

    for await (const subscription of subscriptions) {
      try {
        await unsubscribe(subscription)
      } catch (error) {
        logger.info('Failed to unsubscribe', error)
      }
    }
  } catch (error) {
    logger.info('Failed to unsubscribe all', error)
  }
}

export const createSubscription = async (
  userId: string,
  name: string,
  newsletterEmail?: NewsletterEmail,
  status = SubscriptionStatus.Active,
  unsubscribeMailTo?: string,
  subscriptionType = SubscriptionType.Newsletter,
  url?: string
): Promise<Subscription> => {
  return getRepository(Subscription).save({
    user: { id: userId },
    name,
    newsletterEmail,
    status,
    unsubscribeMailTo,
    lastFetchedAt: new Date(),
    type: subscriptionType,
    url,
  })
}

export const deleteSubscription = async (id: string): Promise<DeleteResult> => {
  return getRepository(Subscription).delete(id)
}

export const createRssSubscriptions = async (
  subscriptions: DeepPartial<Subscription>[]
) => {
  return getRepository(Subscription).save(subscriptions)
}
