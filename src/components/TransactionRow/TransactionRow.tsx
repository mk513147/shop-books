import React, { useEffect } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	Easing,
} from "react-native-reanimated";
import { theme } from "@theme";
import ImageGrid from "@components/ImageGrid/ImageGrid";

type Props = {
	item: any;
	isExpanded: boolean;
	onToggle: () => void;
	onOpenViewer: (images: string[], index: number) => void;
};

export default function TransactionRow({
	item,
	isExpanded,
	onToggle,
	onOpenViewer,
}: Props) {
	const progress = useSharedValue(0);

	useEffect(() => {
		progress.value = withTiming(isExpanded ? 1 : 0, {
			duration: 350,
			easing: Easing.out(Easing.cubic),
		});
	}, [isExpanded]);

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: progress.value,
		transform: [
			{ translateY: (1 - progress.value) * -12 },
			{ scale: 0.97 + progress.value * 0.03 },
		],
	}));

	return (
		<View
			style={{
				marginHorizontal: 8,
				marginVertical: 4,
			}}
		>
			<TouchableOpacity
				onPress={onToggle}
				activeOpacity={0.9}
				style={{
					backgroundColor: theme.colors.card,
					padding: 12,
					borderRadius: 10,
				}}
			>
				{/* Compact Row */}
				<View
					style={{
						flexDirection: "row",
						justifyContent: "space-between",
					}}
				>
					<Text>{item.category}</Text>

					<Text
						style={{
							color:
								item.type === "income"
									? theme.colors.income
									: theme.colors.expense,
							fontWeight: "600",
						}}
					>
						₹ {item.amount}
					</Text>
				</View>

				<Text
					style={{
						color: theme.colors.textSecondary,
						marginTop: 4,
					}}
				>
					{item.date}
				</Text>

				{/* Expanded Section */}
				{isExpanded && (
					<Animated.View
						style={[
							{
								marginTop: 10,
							},
							animatedStyle,
						]}
					>
						{item.supplierName && <Text>Supplier: {item.supplierName}</Text>}
						{item.note && <Text>Note: {item.note}</Text>}
						<Text>Payment: {item.paymentType}</Text>

						{item.imagePath && (
							<ImageGrid
								imagePath={item.imagePath}
								onPressImage={onOpenViewer}
							/>
						)}
					</Animated.View>
				)}
			</TouchableOpacity>
		</View>
	);
}
